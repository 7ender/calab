package webhook

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/redisx"
)

// Delivery is one outbox row as the worker sees it.
type Delivery struct {
	ID        uuid.UUID
	Owner     uuid.UUID // whose webhook: the bot, the board
	Event     string    // the event type, if the queue has one
	Payload   []byte    // nil = finished elsewhere (nothing to send)
	Attempts  int32
	CreatedAt time.Time
}

// Target is an owner's webhook as the worker uses it.
type Target struct {
	URL    string
	Secret []byte
}

// Queue is an outbox the Worker delivers: bot_webhook_deliveries, board_webhook_deliveries.
// Its writes are done outside any request (background work: no admission).
type Queue interface {
	// Claim takes up to limit due deliveries and moves them lease ahead (a crashed worker's
	// rows come back after the lease).
	Claim(ctx context.Context, lease time.Duration, limit int32) ([]Delivery, error)
	// Target returns the working webhook of an owner; false = removed or disabled.
	Target(ctx context.Context, owner uuid.UUID) (Target, bool)
	// Headers are the request headers of a delivery (User-Agent, delivery id, signature).
	Headers(d Delivery, t Target, now time.Time) http.Header
	// Delivered marks the delivery done and the owner's webhook working.
	Delivered(ctx context.Context, d Delivery) error
	// Retry schedules the next attempt.
	Retry(ctx context.Context, d Delivery, next time.Time, msg string) error
	// Failed drops the delivery.
	Failed(ctx context.Context, d Delivery, msg string) error
	// Failing records a failure of the owner's webhook and returns since when it fails.
	Failing(ctx context.Context, owner uuid.UUID, msg string) (*time.Time, error)
	// Disable turns off a webhook failing for GiveUp: its pending deliveries are dropped and
	// its managers are told.
	Disable(ctx context.Context, owner uuid.UUID)
	// Cleanup removes finished deliveries created before t.
	Cleanup(ctx context.Context, before time.Time) error
}

const (
	lease   = 2 * time.Minute
	batch   = 50
	workers = 8
	// Retention of finished deliveries.
	Retention = 7 * 24 * time.Hour
)

// Worker delivers a Queue while this instance holds the queue's Valkey lock.
type Worker struct {
	q     Queue
	tr    *Transport
	opts  Options
	redis rueidis.Client
	key   string
	token string
	wake  chan struct{}
	now   func() time.Time
}

// NewWorker creates the worker of a queue; lockKey names its lock ("bots:webhook:worker").
func NewWorker(q Queue, tr *Transport, r rueidis.Client, lockKey string, o Options) *Worker {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return &Worker{q: q, tr: tr, opts: o.WithDefaults(), redis: r, key: lockKey, token: hex.EncodeToString(b),
		wake: make(chan struct{}, 1), now: time.Now}
}

// Options returns the effective options.
func (w *Worker) Options() Options { return w.opts }

// Wake makes the worker of this instance look for due deliveries now (after a commit that
// queued some); other instances catch up by polling. nil-safe.
func (w *Worker) Wake() {
	if w == nil {
		return
	}
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

var lockScript = rueidis.NewLuaScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
return 0
`)

func (w *Worker) lock(ctx context.Context) bool {
	ttl := max(3*w.opts.Poll, 10*time.Second)
	n, err := lockScript.Exec(ctx, w.redis, []string{redisx.Key(w.key)}, []string{w.token, fmt.Sprint(ttl.Milliseconds())}).AsInt64()
	if err != nil {
		slog.WarnContext(ctx, "webhooks: worker lock", "queue", w.key, "err", err)
		return false
	}
	return n == 1
}

// Run delivers webhooks while this instance holds the worker lock, until ctx is done.
func (w *Worker) Run(ctx context.Context) {
	t := time.NewTicker(w.opts.Poll)
	defer t.Stop()
	var lastCleanup time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-w.wake:
		}
		if !w.lock(ctx) {
			continue
		}
		if _, err := w.Process(ctx); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "webhooks: process", "queue", w.key, "err", err)
		}
		if time.Since(lastCleanup) > time.Hour {
			lastCleanup = time.Now()
			if err := w.q.Cleanup(ctx, w.now().Add(-Retention)); err != nil {
				slog.WarnContext(ctx, "webhooks: cleanup", "queue", w.key, "err", err)
			}
		}
	}
}

// Process delivers due webhooks (several batches) and returns how many succeeded. The caller
// must hold the worker lock.
func (w *Worker) Process(ctx context.Context) (int, error) {
	sent := 0
	for range 20 {
		rows, err := w.q.Claim(ctx, lease, batch)
		if err != nil {
			return sent, err
		}
		type target struct {
			t  Target
			ok bool
		}
		targets := map[uuid.UUID]target{}
		for _, row := range rows {
			if _, ok := targets[row.Owner]; !ok {
				t, ok := w.q.Target(ctx, row.Owner)
				targets[row.Owner] = target{t, ok}
			}
		}
		var (
			wg  sync.WaitGroup
			mu  sync.Mutex
			sem = make(chan struct{}, workers)
		)
		for _, row := range rows {
			sem <- struct{}{}
			wg.Add(1)
			go func() {
				defer func() { <-sem; wg.Done() }()
				t := targets[row.Owner]
				if w.deliver(ctx, row, t.t, t.ok) {
					mu.Lock()
					sent++
					mu.Unlock()
				}
			}()
		}
		wg.Wait()
		if len(rows) < batch {
			return sent, nil
		}
	}
	return sent, nil
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
func (w *Worker) deliver(ctx context.Context, row Delivery, t Target, ok bool) bool {
	log := slog.With("queue", w.key, "delivery_id", row.ID, "owner", row.Owner, "attempt", row.Attempts+1)
	if !ok || row.Payload == nil {
		if err := w.q.Failed(ctx, row, "webhook removed or disabled"); err != nil {
			log.WarnContext(ctx, "webhooks: mark failed", "err", err)
		}
		return false
	}
	_, err := w.tr.Post(ctx, t.URL, row.Payload, w.q.Headers(row, t, w.now()))
	if err == nil {
		if e := w.q.Delivered(ctx, row); e != nil {
			log.WarnContext(ctx, "webhooks: mark delivered", "err", e)
		}
		return true
	}
	msg := clipErr(err.Error())
	at := w.now()
	// A delivery lives GiveUp plus the first backoff, and its last attempt is made at the
	// end of that: a webhook that failed all along is then failing for at least GiveUp when
	// the last attempt fails, and gets disabled below.
	end := row.CreatedAt.Add(w.opts.GiveUp + w.opts.Backoff(0))
	if !at.Before(end) {
		if e := w.q.Failed(ctx, row, msg); e != nil {
			log.WarnContext(ctx, "webhooks: mark failed", "err", e)
		}
	} else if e := w.q.Retry(ctx, row, minTime(at.Add(w.opts.Backoff(row.Attempts)), end), msg); e != nil {
		log.WarnContext(ctx, "webhooks: mark retry", "err", e)
	}
	log.InfoContext(ctx, "webhook delivery failed", "err", msg)
	since, e := w.q.Failing(ctx, row.Owner, msg)
	if e != nil || since == nil || at.Sub(*since) < w.opts.GiveUp {
		return false
	}
	w.q.Disable(ctx, row.Owner)
	return false
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
