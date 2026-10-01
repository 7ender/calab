package bots

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/redisx"
)

// ---- the worker ----

var lockScript = rueidis.NewLuaScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
return 0
`)

func (s *Service) lock(ctx context.Context) bool {
	ttl := max(3*s.wh.opts.Poll, 10*time.Second)
	n, err := lockScript.Exec(ctx, s.redis, []string{redisx.Key(lockKey)}, []string{s.wh.token, fmt.Sprint(ttl.Milliseconds())}).AsInt64()
	if err != nil {
		slog.WarnContext(ctx, "bot webhooks: worker lock", "err", err)
		return false
	}
	return n == 1
}

// Run delivers webhooks while this instance holds the worker lock, until ctx is done.
func (s *Service) Run(ctx context.Context) {
	t := time.NewTicker(s.wh.opts.Poll)
	defer t.Stop()
	var lastCleanup time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-s.wh.wake:
		}
		if !s.lock(ctx) {
			continue
		}
		if _, err := s.ProcessWebhooks(ctx); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "bot webhooks: process", "err", err)
		}
		if time.Since(lastCleanup) > time.Hour {
			lastCleanup = time.Now()
			if _, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (int64, error) {
				return guarded.DeleteOldWebhookDeliveries(ctx, now().Add(-7*24*time.Hour))
			}); err != nil {
				slog.WarnContext(ctx, "bot webhooks: cleanup", "err", err)
			}
		}
	}
}

// target is a bot's webhook as the worker uses it.
type target struct {
	url    string
	secret []byte
	ok     bool
}

// ProcessWebhooks delivers due webhooks (several batches) and returns how many succeeded.
// The caller must hold the worker lock.
func (s *Service) ProcessWebhooks(ctx context.Context) (int, error) {
	sent := 0
	for range 20 {
		rows, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) ([]sqlc.BotWebhookDelivery, error) {
			return guarded.ClaimWebhookDeliveries(ctx, sqlc.ClaimWebhookDeliveriesParams{
				Lease: pgtype.Interval{Microseconds: webhookLease.Microseconds(), Valid: true}, Lim: webhookBatch,
			})
		})
		if err != nil {
			return sent, err
		}
		targets := map[uuid.UUID]target{}
		for _, row := range rows {
			if _, ok := targets[row.BotUserID]; !ok {
				targets[row.BotUserID] = s.target(ctx, row.BotUserID)
			}
		}
		var (
			wg  sync.WaitGroup
			mu  sync.Mutex
			sem = make(chan struct{}, webhookWorkers)
		)
		for _, row := range rows {
			sem <- struct{}{}
			wg.Add(1)
			go func() {
				defer func() { <-sem; wg.Done() }()
				if s.deliver(ctx, row, targets[row.BotUserID]) {
					mu.Lock()
					sent++
					mu.Unlock()
				}
			}()
		}
		wg.Wait()
		if len(rows) < webhookBatch {
			return sent, nil
		}
	}
	return sent, nil
}

func (s *Service) target(ctx context.Context, bot uuid.UUID) target {
	b, err := s.db.Q.GetBot(ctx, bot)
	if err != nil || b.WebhookUrl == nil || b.WebhookDisabledAt != nil || b.TokenHash == nil {
		return target{}
	}
	secret, err := s.box.Open(b.WebhookSecretEnc)
	if err != nil {
		slog.WarnContext(ctx, "bot webhooks: secret", "bot_id", bot, "err", err)
		return target{}
	}
	return target{url: *b.WebhookUrl, secret: secret, ok: true}
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

// Sign returns the X-Calab-Signature value of a body.
func Sign(secret, body []byte) string {
	m := hmac.New(sha256.New, secret)
	m.Write(body)
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}

func clipErr(s string) string {
	if len(s) > 300 {
		s = s[:300]
		for len(s) > 0 && !utf8.ValidString(s) {
			s = s[:len(s)-1]
		}
	}
	return s
}

// deliver POSTs one delivery and records the outcome; true = delivered.
func (s *Service) deliver(ctx context.Context, row sqlc.BotWebhookDelivery, t target) bool {
	log := slog.With("delivery_id", row.ID, "bot_id", row.BotUserID, "attempt", row.Attempts+1)
	if !t.ok || row.Payload == nil {
		if err := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
			return guarded.MarkWebhookFailed(ctx, sqlc.MarkWebhookFailedParams{ID: row.ID, Error: "webhook removed or disabled"})
		}); err != nil {
			log.WarnContext(ctx, "bot webhooks: mark failed", "err", err)
		}
		return false
	}
	err := s.post(ctx, row, t)
	if err == nil {
		if e := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error { return guarded.MarkWebhookDelivered(ctx, row.ID) }); e != nil {
			log.WarnContext(ctx, "bot webhooks: mark delivered", "err", e)
		}
		if e := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error { return guarded.BotWebhookOK(ctx, row.BotUserID) }); e != nil {
			log.WarnContext(ctx, "bot webhooks: mark ok", "err", e)
		}
		return true
	}
	msg := clipErr(err.Error())
	at := now()
	// A delivery lives GiveUp plus the first backoff, and its last attempt is made at the
	// end of that: a webhook that failed all along is then failing for at least GiveUp when
	// the last attempt fails, and gets disabled below.
	end := row.CreatedAt.Add(s.wh.opts.GiveUp + s.wh.opts.Backoff(0))
	if !at.Before(end) {
		if e := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
			return guarded.MarkWebhookFailed(ctx, sqlc.MarkWebhookFailedParams{ID: row.ID, Error: msg})
		}); e != nil {
			log.WarnContext(ctx, "bot webhooks: mark failed", "err", e)
		}
	} else if e := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
		return guarded.MarkWebhookRetry(ctx, sqlc.MarkWebhookRetryParams{
			ID: row.ID, NextAt: minTime(at.Add(s.wh.opts.Backoff(row.Attempts)), end), Error: msg,
		})
	}); e != nil {
		log.WarnContext(ctx, "bot webhooks: mark retry", "err", e)
	}
	log.InfoContext(ctx, "bot webhook delivery failed", "err", msg)
	b, e := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.Bot, error) {
		return guarded.BotWebhookFailing(ctx, sqlc.BotWebhookFailingParams{UserID: row.BotUserID, WebhookLastError: msg})
	})
	if e != nil || b.WebhookFailingSince == nil || at.Sub(*b.WebhookFailingSince) < s.wh.opts.GiveUp {
		return false
	}
	s.disable(ctx, row.BotUserID)
	return false
}

// disable turns off a webhook that failed for GiveUp: pending deliveries are dropped and the
// bot's owner and managers get BOT_UPDATE (webhook.disabled_at).
func (s *Service) disable(ctx context.Context, bot uuid.UUID) {
	changed := false
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		_, err := q.DisableBotWebhook(ctx, bot)
		if db.IsNotFound(err) {
			return nil // already disabled (another delivery of the batch)
		}
		if err != nil {
			return err
		}
		changed = true
		return q.FailPendingWebhookDeliveries(ctx, sqlc.FailPendingWebhookDeliveriesParams{BotUserID: bot, Error: "webhook disabled after a day of failures"})
	})
	if err != nil {
		slog.WarnContext(ctx, "bot webhooks: disable", "bot_id", bot, "err", err)
		return
	}
	if changed {
		slog.WarnContext(ctx, "bot webhook disabled after a day of failures", "bot_id", bot)
		s.hooks.invalidate()
		s.announce(ctx, bot)
	}
}

func (s *Service) post(ctx context.Context, row sqlc.BotWebhookDelivery, t target) error {
	if _, err := s.checkWebhookURL(t.url); err != nil {
		return fmt.Errorf("webhook URL not allowed")
	}
	rctx, cancel := context.WithTimeout(ctx, webhookTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodPost, t.url, bytes.NewReader(row.Payload)) //nolint:gosec // G704: https only, SSRF-safe dialer
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "CalabBot-Webhook/1.0")
	req.Header.Set("X-Calab-Delivery", row.ID.String())
	req.Header.Set("X-Calab-Signature", Sign(t.secret, row.Payload))
	resp, err := s.wh.client.Do(req) //nolint:gosec // G704: see above
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}
