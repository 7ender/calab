package bots

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/webhook"
)

// ---- the worker: bot_webhook_deliveries as a webhook.Queue ----

// Run delivers webhooks while this instance holds the worker lock, until ctx is done.
func (s *Service) Run(ctx context.Context) { s.wh.worker.Run(ctx) }

// ProcessWebhooks delivers due webhooks (several batches) and returns how many succeeded.
// The caller must hold the worker lock.
func (s *Service) ProcessWebhooks(ctx context.Context) (int, error) { return s.wh.worker.Process(ctx) }

// queue implements webhook.Queue over bot_webhook_deliveries.
type queue struct{ s *Service }

var _ webhook.Queue = queue{}

func (q queue) Claim(ctx context.Context, lease time.Duration, limit int32) ([]webhook.Delivery, error) {
	rows, err := db.GuardValue(ctx, q.s.db, func(guarded *sqlc.Queries) ([]sqlc.BotWebhookDelivery, error) {
		return guarded.ClaimWebhookDeliveries(ctx, sqlc.ClaimWebhookDeliveriesParams{
			Lease: pgtype.Interval{Microseconds: lease.Microseconds(), Valid: true}, Lim: limit,
		})
	})
	out := make([]webhook.Delivery, len(rows))
	for i, r := range rows {
		out[i] = webhook.Delivery{ID: r.ID, Owner: r.BotUserID, Payload: r.Payload, Attempts: r.Attempts, CreatedAt: r.CreatedAt}
	}
	return out, err
}

func (q queue) Target(ctx context.Context, bot uuid.UUID) (webhook.Target, bool) {
	b, err := q.s.db.Q.GetBot(ctx, bot)
	if err != nil || b.WebhookUrl == nil || b.WebhookDisabledAt != nil || b.TokenHash == nil {
		return webhook.Target{}, false
	}
	secret, err := q.s.box.Open(b.WebhookSecretEnc)
	if err != nil {
		slog.WarnContext(ctx, "bot webhooks: secret", "bot_id", bot, "err", err)
		return webhook.Target{}, false
	}
	return webhook.Target{URL: *b.WebhookUrl, Secret: secret}, true
}

// Headers: bots keep the original signature (sha256= over the body; v1 is backlog, ADR-0058 §4).
func (queue) Headers(d webhook.Delivery, t webhook.Target, _ time.Time) http.Header {
	h := http.Header{}
	h.Set("User-Agent", "CalabBot-Webhook/1.0")
	h.Set("X-Calab-Delivery", d.ID.String())
	h.Set("X-Calab-Signature", Sign(t.Secret, d.Payload))
	return h
}

func (q queue) Delivered(ctx context.Context, d webhook.Delivery) error {
	if err := db.GuardExec(ctx, q.s.db, func(guarded *sqlc.Queries) error { return guarded.MarkWebhookDelivered(ctx, d.ID) }); err != nil {
		return err
	}
	return db.GuardExec(ctx, q.s.db, func(guarded *sqlc.Queries) error { return guarded.BotWebhookOK(ctx, d.Owner) })
}

func (q queue) Retry(ctx context.Context, d webhook.Delivery, next time.Time, msg string) error {
	return db.GuardExec(ctx, q.s.db, func(guarded *sqlc.Queries) error {
		return guarded.MarkWebhookRetry(ctx, sqlc.MarkWebhookRetryParams{ID: d.ID, NextAt: next, Error: msg})
	})
}

func (q queue) Failed(ctx context.Context, d webhook.Delivery, msg string) error {
	return db.GuardExec(ctx, q.s.db, func(guarded *sqlc.Queries) error {
		return guarded.MarkWebhookFailed(ctx, sqlc.MarkWebhookFailedParams{ID: d.ID, Error: msg})
	})
}

func (q queue) Failing(ctx context.Context, bot uuid.UUID, msg string) (*time.Time, error) {
	b, err := db.GuardValue(ctx, q.s.db, func(guarded *sqlc.Queries) (sqlc.Bot, error) {
		return guarded.BotWebhookFailing(ctx, sqlc.BotWebhookFailingParams{UserID: bot, WebhookLastError: msg})
	})
	return b.WebhookFailingSince, err
}

func (q queue) Disable(ctx context.Context, bot uuid.UUID) { q.s.disable(ctx, bot) }

func (q queue) Cleanup(ctx context.Context, before time.Time) error {
	_, err := db.GuardValue(ctx, q.s.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.DeleteOldWebhookDeliveries(ctx, before)
	})
	return err
}

// Sign returns the X-Calab-Signature value of a body.
func Sign(secret, body []byte) string {
	m := hmac.New(sha256.New, secret)
	m.Write(body)
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
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
