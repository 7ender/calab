// Package mail sends transactional email (ADR-0023): verification and password reset
// codes, "you were added" notices and workspace invitations.
//
// Mail is never sent from a request: Enqueue stores it in the Postgres outbox (mail_outbox,
// in the caller's transaction when given one) and a worker delivers it. Every instance runs
// the worker loop, but only the holder of a Valkey lock sends; claimed rows are leased, so
// a lost lock or a crash never sends a mail twice. Failures are retried with exponential
// backoff until the mail's lifetime ends (≤ 24 h). Limits: MAIL_PER_ADDRESS_PER_HOUR per
// recipient (checked on Enqueue: 429), MAIL_PER_HOUR for the server (the worker waits).
package mail

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/textproto"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/sealbox"
)

// Message is one rendered email. Template and Params are kept for tests and logs.
type Message struct {
	To       string
	Subject  string
	Text     string
	HTML     string
	Template Template
	Params   Params
	// ReplyTo: the Reply-To address ("" = none).
	ReplyTo string
	// Calendar: an iCalendar invitation (ADR-0038 §4) sent as text/calendar with
	// CalendarMethod (REQUEST | CANCEL) and attached as invite.ics; "" = none.
	Calendar       string
	CalendarMethod string
}

// Sender delivers a rendered message (SMTP in production, Fake in tests).
type Sender interface {
	Send(ctx context.Context, m Message) error
}

// PermanentError marks a delivery failure that retrying cannot fix (SMTP 5xx, bad template).
type PermanentError struct{ Err error }

func (e *PermanentError) Error() string { return e.Err.Error() }
func (e *PermanentError) Unwrap() error { return e.Err }

// Priorities: codes are waited for by a person on a screen, notifications are not.
const (
	PriorityCode   = 0
	PriorityNotice = 1
)

// Mail is a message to queue.
type Mail struct {
	To       string
	Template Template
	Locale   string
	Params   Params
	Priority int16
	// TTL: the mail is not sent (nor retried) after this; capped at MaxRetry.
	TTL time.Duration
}

// MaxRetry is the longest a mail is retried.
const MaxRetry = 24 * time.Hour

// Config of the service.
type Config struct {
	PerAddressPerHour int // MAIL_PER_ADDRESS_PER_HOUR (3)
	// EventsPerAddressPerHour: meeting mail (event_*) per address, a bucket of its own so that
	// invitations never use up the budget of codes (MAIL_EVENTS_PER_ADDRESS_PER_HOUR, 10).
	EventsPerAddressPerHour int
	PerHour                 int    // MAIL_PER_HOUR (200), server-wide
	Secret                  []byte // seals params at rest (derived key); JWT_SECRET
}

// Service queues and delivers mail.
type Service struct {
	db      *db.DB
	redis   rueidis.Client
	sender  Sender
	box     *sealbox.Box
	perAddr *redisx.RateLimiter
	evAddr  *redisx.RateLimiter // meeting mail (event_*) per address
	global  *redisx.RateLimiter
	wake    chan struct{}
	token   string // this instance's lock token

	// Tunables (tests shorten them).
	Poll    time.Duration // how often the worker looks for due mail / the lock
	LockTTL time.Duration
	Lease   time.Duration // a claimed mail is not picked again for this long
	Batch   int
}

// ErrDisabled is returned when the server has no SMTP configured (503).
var ErrDisabled = httpx.Coded(http.StatusServiceUnavailable, v1.ErrorCode_ERROR_CODE_UNAVAILABLE, "email is not configured on this server")

// New creates the service. sender nil = mail disabled (Enabled() false, Enqueue fails).
func New(cfg Config, d *db.DB, r rueidis.Client, sender Sender) *Service {
	perAddr, perHour := max(cfg.PerAddressPerHour, 1), max(cfg.PerHour, 1)
	evAddr := cfg.EventsPerAddressPerHour
	if evAddr <= 0 {
		evAddr = 10
	}
	return &Service{
		db: d, redis: r, sender: sender, box: sealbox.New("calaba/mail-outbox/v1", cfg.Secret),
		perAddr: redisx.NewRateLimiter(r, "rl:mail-addr:", perAddr, float64(perAddr)/60),
		evAddr:  redisx.NewRateLimiter(r, "rl:mail-event-addr:", evAddr, float64(evAddr)/60),
		global:  redisx.NewRateLimiter(r, "rl:mail-server:", perHour, float64(perHour)/60),
		wake:    make(chan struct{}, 1),
		token:   uuid.NewString(),
		Poll:    2 * time.Second, LockTTL: 30 * time.Second, Lease: 5 * time.Minute, Batch: 10,
	}
}

// Enabled reports whether mail can be sent.
func (s *Service) Enabled() bool { return s != nil && s.sender != nil }

// Enqueue queues m inside q (nil = own statement). It takes one unit of the recipient's
// hourly budget first: 429 (with Retry-After) when it is used up. Call Wake after the
// transaction commits.
func (s *Service) Enqueue(ctx context.Context, q *sqlc.Queries, m Mail) error {
	if !s.Enabled() {
		return ErrDisabled
	}
	if _, ok := templates[m.Template]; !ok {
		return fmt.Errorf("mail: unknown template %q", m.Template)
	}
	lim := s.perAddr
	if isEventTemplate(m.Template) {
		lim = s.evAddr
	}
	if err := lim.Take(ctx, strings.ToLower(m.To)); err != nil {
		return err
	}
	sealed, err := s.seal(m.Params)
	if err != nil {
		return err
	}
	ttl := m.TTL
	if ttl <= 0 || ttl > MaxRetry {
		ttl = MaxRetry
	}
	if q == nil {
		q = s.db.Q
	}
	_, err = q.EnqueueMail(ctx, sqlc.EnqueueMailParams{
		ToAddr: m.To, Template: string(m.Template), Locale: Locale(m.Locale), Params: sealed,
		Priority: m.Priority, ExpiresAt: time.Now().Add(ttl),
	})
	return err
}

// Wake makes this instance's worker look for due mail now (if it holds the lock).
func (s *Service) Wake() {
	if s == nil {
		return
	}
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Service) seal(p Params) ([]byte, error) {
	plain, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	return s.box.Seal(plain)
}

func (s *Service) open(b []byte) (Params, error) {
	plain, err := s.box.Open(b)
	if err != nil {
		return nil, fmt.Errorf("mail: params: %w", err)
	}
	var p Params
	return p, json.Unmarshal(plain, &p)
}

// lockScript takes the worker lock or extends it when this instance already holds it.
var lockScript = rueidis.NewLuaScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
return 0
`)

const lockKey = "mail:worker"

func (s *Service) lock(ctx context.Context) bool {
	n, err := lockScript.Exec(ctx, s.redis, []string{redisx.Key(lockKey)},
		[]string{s.token, fmt.Sprint(s.LockTTL.Milliseconds())}).AsInt64()
	if err != nil {
		slog.WarnContext(ctx, "mail: worker lock", "err", err)
		return false
	}
	return n == 1
}

// Run is the worker loop: until ctx is done, deliver due mail whenever this instance holds
// the lock; hourly, drop finished rows older than 7 days and expired codes.
func (s *Service) Run(ctx context.Context) {
	if !s.Enabled() {
		return
	}
	t := time.NewTicker(s.Poll)
	defer t.Stop()
	var lastCleanup time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-s.wake:
		}
		if !s.lock(ctx) {
			continue
		}
		if _, err := s.ProcessOnce(ctx); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "mail: process outbox", "err", err)
		}
		if time.Since(lastCleanup) > time.Hour {
			lastCleanup = time.Now()
			s.cleanup(ctx)
		}
	}
}

func (s *Service) cleanup(ctx context.Context) {
	now := time.Now()
	if _, err := s.db.Q.DeleteOldMail(ctx, now.Add(-7*24*time.Hour)); err != nil {
		slog.WarnContext(ctx, "mail: cleanup outbox", "err", err)
	}
	if _, err := s.db.Q.DeleteExpiredEmailCodes(ctx, now.Add(-time.Hour)); err != nil {
		slog.WarnContext(ctx, "mail: cleanup codes", "err", err)
	}
}

// ProcessOnce delivers due mail until none is left (or the server-wide limit is reached)
// and returns how many were sent. The caller must hold the worker lock.
func (s *Service) ProcessOnce(ctx context.Context) (int, error) {
	sent := 0
	for range 20 { // ≤ 20 batches per wake-up; the next tick continues
		rows, err := s.db.Q.ClaimMail(ctx, sqlc.ClaimMailParams{Lease: durationInterval(s.Lease), Lim: int32(s.Batch)}) //nolint:gosec // small
		if err != nil {
			return sent, err
		}
		for i, row := range rows {
			ok, wait, err := s.global.Allow(ctx, "all")
			if err != nil || !ok {
				if err != nil {
					wait = 30 * time.Second
				}
				s.postpone(ctx, rows[i:], wait)
				return sent, err
			}
			if s.deliver(ctx, row) {
				sent++
			}
		}
		if len(rows) < s.Batch {
			return sent, nil
		}
	}
	return sent, nil
}

func (s *Service) postpone(ctx context.Context, rows []sqlc.MailOutbox, wait time.Duration) {
	at := time.Now().Add(wait)
	for _, r := range rows {
		if err := s.db.Q.PostponeMail(ctx, sqlc.PostponeMailParams{ID: r.ID, NextAt: at}); err != nil {
			slog.WarnContext(ctx, "mail: postpone", "id", r.ID, "err", err)
		}
	}
}

// Backoff is the wait before retry number attempt+1: 30 s doubling, capped at 1 h.
func Backoff(attempt int32) time.Duration {
	if attempt >= 7 {
		return time.Hour
	}
	return min(30*time.Second<<attempt, time.Hour)
}

// deliver sends one claimed mail and records the outcome; true = sent.
func (s *Service) deliver(ctx context.Context, row sqlc.MailOutbox) bool {
	log := slog.With("mail_id", row.ID, "template", row.Template, "attempt", row.Attempts+1)
	fail := func(err error) {
		if e := s.db.Q.MarkMailFailed(ctx, sqlc.MarkMailFailedParams{ID: row.ID, Error: clipErr(err)}); e != nil {
			log.WarnContext(ctx, "mail: mark failed", "err", e)
		}
		log.WarnContext(ctx, "mail: giving up", "err", err)
	}
	if !time.Now().Before(row.ExpiresAt) {
		fail(errors.New("expired before it could be sent"))
		return false
	}
	params, err := s.open(row.Params)
	if err != nil {
		fail(err)
		return false
	}
	msg, err := Render(Template(row.Template), row.Locale, params)
	if err != nil {
		fail(err)
		return false
	}
	msg.To = row.ToAddr
	sctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	err = s.sender.Send(sctx, msg)
	cancel()
	if err == nil {
		if e := s.db.Q.MarkMailSent(ctx, row.ID); e != nil {
			log.WarnContext(ctx, "mail: mark sent", "err", e)
		}
		log.InfoContext(ctx, "mail sent")
		return true
	}
	next := time.Now().Add(Backoff(row.Attempts))
	if isPermanent(err) || !next.Before(row.ExpiresAt) {
		fail(err)
		return false
	}
	if e := s.db.Q.MarkMailRetry(ctx, sqlc.MarkMailRetryParams{ID: row.ID, NextAt: next, Error: clipErr(err)}); e != nil {
		log.WarnContext(ctx, "mail: mark retry", "err", e)
	}
	log.WarnContext(ctx, "mail: send failed, will retry", "err", err, "next_at", next)
	return false
}

func durationInterval(d time.Duration) pgtype.Interval {
	return pgtype.Interval{Microseconds: d.Microseconds(), Valid: true}
}

func isPermanent(err error) bool {
	var pe *PermanentError
	if errors.As(err, &pe) {
		return true
	}
	var te *textproto.Error
	return errors.As(err, &te) && te.Code >= 500
}

func clipErr(err error) string {
	s := err.Error()
	if len(s) > 500 {
		s = s[:500]
	}
	return strings.ToValidUTF8(s, "")
}
