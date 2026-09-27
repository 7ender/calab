// Package app wires dependencies and routes into one http.Handler. Used by cmd/server
// and by integration tests.
package app

import (
	"context"
	"net/http"
	"net/netip"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/buildinfo"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/dms"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/gateway"
	"github.com/calaba/calaba/server/internal/gptunnel"
	"github.com/calaba/calaba/server/internal/guests"
	"github.com/calaba/calaba/server/internal/health"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/recording"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/superadmin"
	"github.com/calaba/calaba/server/internal/unfurl"
	"github.com/calaba/calaba/server/internal/users"
	"github.com/calaba/calaba/server/internal/workspaces"
)

// Deps are the long-lived dependencies of the server.
type Deps struct {
	Config *config.Config
	DB     *db.DB
	Redis  rueidis.Client
	Events events.Publisher
	Blob   blob.Store
	// LiveKit overrides the LiveKit client (tests); nil = real client from config.
	LiveKit rtc.LiveKit
	// UnfurlAllowAddr overrides the link-preview address policy (tests only, to reach a
	// loopback test server); nil = public addresses only. Deliberately not an env var.
	UnfurlAllowAddr func(netip.Addr) bool
	// Mail overrides the mail transport (tests: mail.Fake); nil = SMTP from config, or no
	// mail when SMTP_HOST is empty.
	Mail mail.Sender
	// Egress overrides the LiveKit Egress client (tests); nil = real client from config.
	Egress rtc.Egress
}

// App is the assembled server.
type App struct {
	Handler http.Handler
	Auth    *auth.Service
	Gateway *gateway.Hub
	Files   *files.Service
	Guests  *guests.Service
	RTC     *rtc.Service // nil when LiveKit is not configured
	Plans   *plans.Service
	Mail    *mail.Service
	// Recording: meeting recording and GPTunneL (ADR-0025).
	Recording *recording.Service
}

// Run starts background work (gateway fan-out, presence sweeper, orphan file cleanup,
// voice reconcile) until ctx is done.
func (a *App) Run(ctx context.Context) {
	go a.Gateway.Run(ctx)
	go a.Files.RunCleanup(ctx, time.Hour)
	go a.Files.RunStorageMetrics(ctx, time.Minute)
	go a.Guests.RunCleanup(ctx, time.Hour)
	go a.Plans.Run(ctx)
	if a.RTC != nil {
		go a.RTC.RunReconcile(ctx, 30*time.Second)
	}
	go a.Mail.Run(ctx) // returns at once without mail
	go a.Recording.Run(ctx)
}

// mailSender: the test override, else SMTP from config, else nil (mail disabled).
func mailSender(d Deps) (mail.Sender, error) {
	if d.Mail != nil {
		return d.Mail, nil
	}
	c := d.Config
	if !c.MailEnabled() {
		return nil, nil
	}
	return mail.NewSMTP(c.SMTPHost, c.SMTPPort, c.SMTPUser, c.SMTPPassword, c.SMTPTLS, c.SMTPFrom)
}

func unfurlPolicy(d Deps) func(netip.Addr) bool {
	if d.UnfurlAllowAddr != nil {
		return d.UnfurlAllowAddr
	}
	if len(d.Config.UnfurlAllowCIDRs) > 0 {
		return unfurl.PublicOrAllowed(d.Config.UnfurlAllowCIDRs)
	}
	return nil // unfurl.PublicAddr
}

// New builds the router. Next stages (gateway, messages, files, rtc) register their
// routes here the same way. The config must be valid (config.Load / Validate): invalid
// PLAN_*_LIMITS panic here.
func New(d Deps) *App {
	superadmin.Configure(d.Config.SuperadminEmails)
	free, team, err := plans.Defaults(d.Config.PlanFreeLimits, d.Config.PlanTeamLimits)
	if err != nil {
		panic(err) // validated by config.Validate
	}
	planSvc := plans.New(d.DB, d.Redis, free, team)
	base := d.Events
	if base == nil {
		base = events.Redis{C: d.Redis}
	}
	// Voice: the rtc service reacts to permission/membership/session events it publishes
	// through SyncPublisher; everything else publishes through the same decorated publisher.
	var rtcSvc *rtc.Service
	pub := base
	if d.Config.LiveKitEnabled() {
		lk := d.LiveKit
		if lk == nil {
			lk = rtc.NewLiveKit(d.Config.LiveKitInternalURL, d.Config.LiveKitAPIKey, d.Config.LiveKitAPISecret)
		}
		rtcSvc = rtc.NewService(rtc.Config{
			PublicURL: d.Config.LiveKitURL, APIKey: d.Config.LiveKitAPIKey, Secret: d.Config.LiveKitAPISecret,
			MaxParticipants: d.Config.LiveKitMaxParticipants,
		}, d.DB, d.Redis, lk, base)
		rtcSvc.Plans = planSvc
		pub = rtc.SyncPublisher{Publisher: base, S: rtcSvc}
	}

	sender, err := mailSender(d)
	if err != nil {
		panic(err) // config.Validate checks the SMTP settings first
	}
	mailSvc := mail.New(mail.Config{
		PerAddressPerHour: d.Config.MailPerAddressPerHour, PerHour: d.Config.MailPerHour, Secret: []byte(d.Config.JWTSecret),
	}, d.DB, d.Redis, sender)

	authSvc := auth.NewService(d.Config, d.DB, d.Redis, pub)
	authSvc.Mail = mailSvc
	authSvc.OnEmailVerified = func(ctx context.Context, u sqlc.User) { workspaces.AcceptEmailInvites(ctx, d.DB, planSvc, pub, u) }
	if rtcSvc != nil {
		rtcSvc.Revoked = authSvc.IsRevoked
	}
	var egress rtc.Egress
	if rtcSvc != nil {
		if egress = d.Egress; egress == nil {
			egress = rtc.NewEgress(d.Config.LiveKitInternalURL, d.Config.LiveKitAPIKey, d.Config.LiveKitAPISecret)
		}
	}
	recSvc := recording.New(recording.Config{
		Dir: d.Config.RecordingsPath, EgressDir: d.Config.RecordingEgressDir,
		MaxConcurrent: d.Config.RecordingMaxConcurrent, Secret: []byte(d.Config.JWTSecret),
	}, d.DB, d.Redis, egress, gptunnel.New(d.Config.GPTunnelAPIURL), pub)
	if rtcSvc != nil {
		rtcSvc.OnEgress = recSvc.HandleEgress
	}
	authLimiter := redisx.NewRateLimiter(d.Redis, "rl:auth:", d.Config.AuthRateBurst, d.Config.AuthRatePerMinute)
	accountLimiter := redisx.NewRateLimiter(d.Redis, "rl:login-acct:", d.Config.LoginAccountBurst, float64(d.Config.LoginAccountBurst)/15) // N per 15 min
	msgLimiter := redisx.NewRateLimiter(d.Redis, "rl:msg:", 5, 60)                                                                         // 5 per 5 s per room and user
	filesSvc := files.NewService(d.DB, d.Blob, pub, d.Config.MaxFileSizeMB<<20, d.Config.StorageMaxTotalBytes)
	filesSvc.SetLimiter(redisx.NewRateLimiter(d.Redis, "rl:upload:", 30, 2)) // 30 at once, 120 per hour
	filesSvc.SetPlans(planSvc)
	hub := gateway.New(gateway.Config{
		HeartbeatInterval:  d.Config.HeartbeatInterval,
		MaxSessionsPerUser: d.Config.MaxDevicesPerUser,
		ShutdownSpread:     5 * time.Second,
		AllowedOrigins:     d.Config.AllowedOrigins(),
		Plans:              planSvc,
		PlanContact:        d.Config.PlanContact(),
	}, d.DB, d.Redis, authSvc, pub)

	// Authenticated API routes: identity + fresh per-request permission resolver + the
	// suspension guard (write routes of suspended workspaces, item 32).
	guard := moderation.Guard(d.DB.Q, func(ctx context.Context) uuid.UUID { return auth.MustFromContext(ctx).UserID })
	private := func(h http.Handler) http.Handler {
		g := guard(h)
		return authSvc.Require(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			g.ServeHTTP(w, r.WithContext(perm.WithResolver(r.Context(), d.DB.Q)))
		}))
	}

	mux := http.NewServeMux()
	health.Routes(mux, d.DB.Pool, d.Redis)
	buildinfo.Routes(mux, d.Config.PlanContact())
	mux.Handle("GET /metrics", promhttp.Handler())
	mux.Handle("GET /gateway", hub)

	ah := auth.NewHandlers(authSvc, authLimiter, accountLimiter, d.Config.AllowedOrigins())
	ah.Public(mux)
	ah.Private(mux, private)
	users.NewHandlers(d.DB, pub, hub).Routes(mux, private)
	workspaces.NewHandlers(d.DB, pub, d.Blob, workspaces.Limits{
		MaxOwned:       d.Config.MaxWorkspacesPerUser,
		Quota:          d.Config.DefaultWorkspaceQuotaBytes,
		CreateLimiter:  redisx.NewRateLimiter(d.Redis, "rl:ws-create:", d.Config.WorkspaceCreatesPerHour, float64(d.Config.WorkspaceCreatesPerHour)/60),
		Plans:          planSvc,
		PreviewLimiter: redisx.NewRateLimiter(d.Redis, "rl:invite-preview:", 30, 30), // 30 per minute per IP
	}).WithEmailInvites(workspaces.EmailInvites{
		Mail: mailSvc, PublicURL: d.Config.PublicAppURL,
		Lookup: redisx.NewRateLimiter(d.Redis, "rl:invite-lookup:", 20, 20), // 20 per minute
		Send:   redisx.NewRateLimiter(d.Redis, "rl:invite-send:", 20, 0.5),  // 20 at once, 30 per hour
	}).Routes(mux, private)
	roomHandlers := rooms.NewHandlers(d.DB, pub)
	roomHandlers.Routes(mux, private)
	roomHandlers.CategoryRoutes(mux, private)
	messages.NewHandlers(d.DB, pub, msgLimiter).Routes(mux, private)
	dms.NewHandlers(d.DB, pub, redisx.NewRateLimiter(d.Redis, "rl:dm-create:", 10, 0.5)).Routes(mux, private) // 10 at once, 30 per hour
	filesSvc.Routes(mux, private)
	guestSvc := guests.NewService(d.DB, authSvc, pub, d.Blob,
		redisx.NewRateLimiter(d.Redis, "rl:guest:", 5, 5.0/60), d.Config.AllowedOrigins()) // 5 guests/h per IP
	guestSvc.Plans = planSvc
	guestSvc.Routes(mux, private)
	plans.NewAdmin(d.DB, planSvc, pub, redisx.NewRateLimiter(d.Redis, "rl:admin:", 60, 60)).Routes(mux, private) // 60 per minute
	unfurl.NewService(d.Redis, []byte(d.Config.JWTSecret),
		redisx.NewRateLimiter(d.Redis, "rl:unfurl:", 30, 120), unfurl.Options{AllowAddr: unfurlPolicy(d)}).Routes(mux, private)
	recSvc.Routes(mux, private)
	if rtcSvc != nil {
		rtcSvc.Routes(mux, private)
	} else {
		rtc.DisabledRoutes(mux, private)
	}
	mux.Handle("/api/", httpx.HandlerFunc(func(http.ResponseWriter, *http.Request) error {
		return httpx.NotFound("route")
	}))

	h := httpx.Chain(mux,
		httpx.WithRequestID,
		httpx.WithClientIP(d.Config.TrustedProxies),
		httpx.APIHeaders,
		httpx.Observe,
		httpx.Recover,
		events.Middleware, // one post-commit publish budget per request
	)
	return &App{Handler: h, Auth: authSvc, Gateway: hub, Files: filesSvc, Guests: guestSvc, RTC: rtcSvc, Plans: planSvc, Mail: mailSvc, Recording: recSvc}
}
