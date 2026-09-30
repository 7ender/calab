package bots

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"log/slog"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/unfurl"
)

// Webhooks (ADR-0031 §4). Events a bot would get from the gateway — messages and reactions
// of rooms it can view, and of its DMs — are also queued for bots with a webhook, as rows
// of bot_webhook_deliveries, after the change committed (Publisher). One worker in the
// cluster (Valkey lock) POSTs them with an HMAC signature; failures are retried with
// backoff 1 min → 1 h for up to a day; a webhook failing for a day is disabled and the bot's
// owner and managers get BOT_UPDATE with its state.

// WebhookOptions tune delivery; zero values are the production defaults.
type WebhookOptions struct {
	// AllowAddr: which resolved addresses may be dialed (nil = unfurl.PublicAddr; tests
	// allow loopback). Webhook URLs are https only.
	AllowAddr func(netip.Addr) bool
	// RootCAs trusts extra certificate authorities (tests: httptest TLS servers); nil = system.
	RootCAs *x509.CertPool
	// Poll: how often the worker looks for due deliveries (default 2 s).
	Poll time.Duration
	// Backoff: wait before retry attempt+1 (default 1 min doubling, at most 1 h).
	Backoff func(attempt int32) time.Duration
	// GiveUp: a delivery is dropped, and a webhook failing that long is disabled (default 24 h).
	GiveUp time.Duration
}

// Backoff is the default retry schedule: 1 min doubling, capped at 1 h.
func Backoff(attempt int32) time.Duration {
	if attempt >= 6 {
		return time.Hour
	}
	return min(time.Minute<<attempt, time.Hour)
}

const (
	webhookTimeout = 10 * time.Second
	webhookLease   = 2 * time.Minute
	webhookBatch   = 50
	webhookWorkers = 8
	hooksTTL       = 30 * time.Second
	minSecret      = 16
	maxSecret      = 256
	maxWebhookURL  = 2048
	lockKey        = "bots:webhook:worker"
)

type webhookWorker struct {
	opts   WebhookOptions
	client *http.Client
	allow  func(netip.Addr) bool
	wake   chan struct{}
	token  string
}

func newWebhookWorker(o WebhookOptions) webhookWorker {
	if o.AllowAddr == nil {
		o.AllowAddr = unfurl.PublicAddr
	}
	if o.Poll <= 0 {
		o.Poll = 2 * time.Second
	}
	if o.Backoff == nil {
		o.Backoff = Backoff
	}
	if o.GiveUp <= 0 {
		o.GiveUp = 24 * time.Hour
	}
	tr := unfurl.SafeTransport(webhookTimeout, o.AllowAddr)
	if o.RootCAs != nil {
		tr.TLSClientConfig = &tls.Config{RootCAs: o.RootCAs, MinVersion: tls.VersionTLS12}
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return webhookWorker{
		opts: o, allow: o.AllowAddr, wake: make(chan struct{}, 1), token: hex.EncodeToString(b),
		client: &http.Client{
			Transport: tr, Timeout: webhookTimeout,
			// A redirect is an answer, not a success: never follow it (SSRF).
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

// ---- which bots have webhooks ----

// hookCache: bots with a working webhook, by workspace (reloaded every hooksTTL, and after
// local changes; other instances catch up within hooksTTL).
type hookCache struct {
	mu   sync.Mutex
	at   time.Time
	byWS map[uuid.UUID][]uuid.UUID
	bots map[uuid.UUID]bool
}

func (c *hookCache) invalidate() {
	c.mu.Lock()
	c.at = time.Time{}
	c.mu.Unlock()
}

func (s *Service) webhookBots(ctx context.Context) (map[uuid.UUID][]uuid.UUID, map[uuid.UUID]bool) {
	c := &s.hooks
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.at) < hooksTTL {
		return c.byWS, c.bots
	}
	rows, err := s.db.Q.ListWebhookBots(ctx)
	if err != nil {
		slog.WarnContext(ctx, "bot webhooks: list", "err", err)
		return c.byWS, c.bots // keep the previous set
	}
	byWS, bots := map[uuid.UUID][]uuid.UUID{}, map[uuid.UUID]bool{}
	for _, r := range rows {
		bots[r.UserID] = true
		if r.WorkspaceID != nil {
			byWS[*r.WorkspaceID] = append(byWS[*r.WorkspaceID], r.UserID)
		}
	}
	c.byWS, c.bots, c.at = byWS, bots, time.Now()
	return byWS, bots
}

// ---- queueing ----

// Publisher decorates the event publisher: workspace and user events that bots with a
// webhook would receive are queued for them after being published.
type Publisher struct {
	events.Publisher
	S *Service
}

// Workspace implements events.Publisher.
func (p Publisher) Workspace(ctx context.Context, workspaceID uuid.UUID, ev *v1.DispatchEvent) {
	p.Publisher.Workspace(ctx, workspaceID, ev)
	p.S.onWorkspaceEvent(ctx, workspaceID, ev)
}

// User implements events.Publisher.
func (p Publisher) User(ctx context.Context, userID uuid.UUID, ev *v1.DispatchEvent) {
	p.Publisher.User(ctx, userID, ev)
	p.S.onUserEvent(ctx, userID, ev)
}

// BotCallback is intentionally excluded: its private outbox entry is committed atomically
// with the interaction receipt by messages.interact, never fanned out to room bots.
// deliverable: the room and actor (author / reacting user; Nil = unknown) of an event bots
// get by webhook.
func deliverable(ev *v1.DispatchEvent) (room, actor uuid.UUID, ok bool) {
	parse := func(s string) uuid.UUID { id, _ := uuid.Parse(s); return id }
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_MessageCreate:
		m := e.MessageCreate.GetMessage()
		return parse(m.GetRoomId()), parse(m.GetAuthorId()), true
	case *v1.DispatchEvent_MessageUpdate:
		m := e.MessageUpdate.GetMessage()
		return parse(m.GetRoomId()), parse(m.GetAuthorId()), true
	case *v1.DispatchEvent_MessageDelete:
		return parse(e.MessageDelete.GetRoomId()), uuid.Nil, true
	case *v1.DispatchEvent_MessageReactionAdd:
		return parse(e.MessageReactionAdd.GetRoomId()), parse(e.MessageReactionAdd.GetUserId()), true
	case *v1.DispatchEvent_MessageReactionRemove:
		return parse(e.MessageReactionRemove.GetRoomId()), parse(e.MessageReactionRemove.GetUserId()), true
	}
	return uuid.Nil, uuid.Nil, false
}

// queueCtx bounds the post-commit queueing work of one event.
func queueCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
}

func (s *Service) onWorkspaceEvent(ctx context.Context, wsID uuid.UUID, ev *v1.DispatchEvent) {
	room, actor, ok := deliverable(ev)
	if !ok {
		return
	}
	ctx, cancel := queueCtx(ctx)
	defer cancel()
	byWS, _ := s.webhookBots(ctx)
	cands := byWS[wsID]
	if len(cands) == 0 {
		return
	}
	res := perm.NewResolver(s.db.Q)
	var targets []uuid.UUID
	for _, b := range cands {
		if b == actor {
			continue // its own messages and reactions
		}
		if acc, err := res.Room(ctx, room, b); err == nil && acc.Bits.Has(perm.ViewRoom) {
			targets = append(targets, b)
		}
	}
	s.enqueue(ctx, targets, ev)
}

// onUserEvent: events of a DM come on the participants' user channels.
func (s *Service) onUserEvent(ctx context.Context, userID uuid.UUID, ev *v1.DispatchEvent) {
	_, actor, ok := deliverable(ev)
	if !ok || actor == userID {
		return
	}
	ctx, cancel := queueCtx(ctx)
	defer cancel()
	if _, bots := s.webhookBots(ctx); !bots[userID] {
		return
	}
	s.enqueue(ctx, []uuid.UUID{userID}, ev)
}

// ForBot returns ev as bot should get it: a MESSAGE_CREATE command addressed to another bot
// is removed (ADR-0031 §6). ev itself is not modified.
func ForBot(ev *v1.DispatchEvent, bot string) *v1.DispatchEvent {
	mc := ev.GetMessageCreate()
	if cmd := mc.GetMessage().GetCommand(); cmd == nil || cmd.GetBotUserId() == bot {
		return ev
	}
	return WithoutCommand(ev)
}

// WithoutCommand returns a MESSAGE_CREATE without Message.command (a copy).
func WithoutCommand(ev *v1.DispatchEvent) *v1.DispatchEvent {
	mc := ev.GetMessageCreate()
	m := proto.CloneOf(mc.GetMessage())
	m.Command = nil
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{MessageCreate: &v1.MessageCreate{WorkspaceId: mc.GetWorkspaceId(), Message: m}}}
}

var payloadJSON = protojson.MarshalOptions{EmitDefaultValues: true}

func (s *Service) enqueue(ctx context.Context, bots []uuid.UUID, ev *v1.DispatchEvent) {
	if len(bots) == 0 {
		return
	}
	p := sqlc.EnqueueWebhookDeliveriesParams{}
	for _, b := range bots {
		id, err := uuid.NewV7()
		if err != nil {
			continue
		}
		body, err := payloadJSON.Marshal(&v1.BotWebhookUpdate{
			Id: id.String(), BotUserId: b.String(), CreatedAt: timestamppb.New(now()), Event: ForBot(ev, b.String()),
		})
		if err != nil {
			slog.ErrorContext(ctx, "bot webhook: encode", "err", err)
			continue
		}
		p.Ids, p.BotIds, p.Payloads = append(p.Ids, id), append(p.BotIds, b), append(p.Payloads, body)
	}
	if err := s.db.Q.EnqueueWebhookDeliveries(ctx, p); err != nil {
		// A bot that was just deleted (FK) or a Postgres hiccup: the event is lost for the
		// webhook, like a missed event for a socket; the bot resyncs over REST.
		slog.WarnContext(ctx, "bot webhook: enqueue", "bots", len(p.BotIds), "err", err)
		return
	}
	select {
	case s.wh.wake <- struct{}{}:
	default:
	}
}

// ---- the bot's webhook endpoints ----

// checkWebhookURL: absolute https URL without credentials; a literal IP address must be
// allowed by the SSRF policy (host names are checked when dialing).
func (s *Service) checkWebhookURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if len(raw) > maxWebhookURL {
		return "", httpx.Validation("url", "URL is too long")
	}
	u, err := unfurl.CheckURL(raw)
	if err != nil || u.Scheme != "https" {
		return "", httpx.Validation("url", "webhook URL must be an absolute https URL without credentials")
	}
	host := u.Hostname()
	if a, err := netip.ParseAddr(host); err == nil && !s.wh.allow(a) {
		return "", httpx.Validation("url", "webhook URL must point to a public address")
	}
	if h := strings.ToLower(host); h == "localhost" || strings.HasSuffix(h, ".localhost") {
		if !s.wh.allow(netip.MustParseAddr("127.0.0.1")) {
			return "", httpx.Validation("url", "webhook URL must point to a public address")
		}
	}
	return u.String(), nil
}

func (s *Service) webhookResponse(ctx context.Context, id uuid.UUID) (*v1.BotWebhookResponse, error) {
	b, err := s.db.Q.GetBot(ctx, id)
	if err != nil {
		return nil, err
	}
	wh := webhookPB(b)
	n, err := s.db.Q.CountPendingWebhookDeliveries(ctx, id)
	if err != nil {
		return nil, err
	}
	wh.Pending = uint32(min(n, 1<<31)) //nolint:gosec // bounded
	return &v1.BotWebhookResponse{Webhook: wh}, nil
}

func (s *Service) getWebhook(w http.ResponseWriter, r *http.Request) error {
	if err := auth.BotsOnly(r.Context()); err != nil {
		return err
	}
	resp, err := s.webhookResponse(r.Context(), identity(r).UserID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

func (s *Service) setWebhook(w http.ResponseWriter, r *http.Request) error {
	if err := auth.BotsOnly(r.Context()); err != nil {
		return err
	}
	id := identity(r).UserID
	var req v1.SetBotWebhookRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	u, err := s.checkWebhookURL(req.GetUrl())
	if err != nil {
		return err
	}
	if n := utf8.RuneCountInString(req.GetSecret()); n < minSecret || n > maxSecret {
		return httpx.Validation("secret", "secret must be 16..256 characters")
	}
	sealed, err := s.box.Seal([]byte(req.GetSecret()))
	if err != nil {
		return err
	}
	if _, err := s.db.Q.SetBotWebhook(r.Context(), sqlc.SetBotWebhookParams{UserID: id, WebhookUrl: &u, WebhookSecretEnc: sealed}); err != nil {
		return err
	}
	s.hooks.invalidate()
	s.announce(r.Context(), id)
	resp, err := s.webhookResponse(r.Context(), id)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

func (s *Service) deleteWebhook(w http.ResponseWriter, r *http.Request) error {
	if err := auth.BotsOnly(r.Context()); err != nil {
		return err
	}
	id := identity(r).UserID
	err := s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if _, err := q.ClearBotWebhook(r.Context(), id); err != nil {
			return err
		}
		return q.FailPendingWebhookDeliveries(r.Context(), sqlc.FailPendingWebhookDeliveriesParams{BotUserID: id, Error: "webhook removed"})
	})
	if err != nil {
		return err
	}
	s.hooks.invalidate()
	s.announce(r.Context(), id)
	httpx.NoContent(w)
	return nil
}
