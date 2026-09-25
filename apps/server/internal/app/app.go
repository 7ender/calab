// Package app wires dependencies and routes into one http.Handler. Used by cmd/server
// and by integration tests.
package app

import (
	"context"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/gateway"
	"github.com/calaba/calaba/server/internal/health"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/calaba/calaba/server/internal/rtc"
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
}

// App is the assembled server.
type App struct {
	Handler http.Handler
	Auth    *auth.Service
	Gateway *gateway.Hub
	Files   *files.Service
	RTC     *rtc.Service // nil when LiveKit is not configured
}

// Run starts background work (gateway fan-out, presence sweeper, orphan file cleanup,
// voice reconcile) until ctx is done.
func (a *App) Run(ctx context.Context) {
	go a.Gateway.Run(ctx)
	go a.Files.RunCleanup(ctx, time.Hour)
	if a.RTC != nil {
		go a.RTC.RunReconcile(ctx, 30*time.Second)
	}
}

// New builds the router. Next stages (gateway, messages, files, rtc) register their
// routes here the same way.
func New(d Deps) *App {
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
		pub = rtc.SyncPublisher{Publisher: base, S: rtcSvc}
	}

	authSvc := auth.NewService(d.Config, d.DB, d.Redis, pub)
	if rtcSvc != nil {
		rtcSvc.Revoked = authSvc.IsRevoked
	}
	authLimiter := redisx.NewRateLimiter(d.Redis, "rl:auth:", d.Config.AuthRateBurst, d.Config.AuthRatePerMinute)
	msgLimiter := redisx.NewRateLimiter(d.Redis, "rl:msg:", 5, 60) // 5 per 5 s per room and user
	filesSvc := files.NewService(d.DB, d.Blob, pub, d.Config.MaxFileSizeMB<<20)
	hub := gateway.New(gateway.Config{
		HeartbeatInterval:  d.Config.HeartbeatInterval,
		MaxSessionsPerUser: d.Config.MaxDevicesPerUser,
		ShutdownSpread:     5 * time.Second,
		AllowedOrigins:     d.Config.AllowedOrigins(),
	}, d.DB, d.Redis, authSvc, pub)

	// Authenticated API routes: identity + fresh per-request permission resolver.
	private := func(h http.Handler) http.Handler {
		return authSvc.Require(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h.ServeHTTP(w, r.WithContext(perm.WithResolver(r.Context(), d.DB.Q)))
		}))
	}

	mux := http.NewServeMux()
	health.Routes(mux, d.DB.Pool, d.Redis)
	mux.Handle("GET /metrics", promhttp.Handler())
	mux.Handle("GET /gateway", hub)

	ah := auth.NewHandlers(authSvc, authLimiter, d.Config.AllowedOrigins())
	ah.Public(mux)
	ah.Private(mux, private)
	users.NewHandlers(d.DB, pub).Routes(mux, private)
	workspaces.NewHandlers(d.DB, pub, d.Blob).Routes(mux, private)
	rooms.NewHandlers(d.DB, pub).Routes(mux, private)
	messages.NewHandlers(d.DB, pub, msgLimiter).Routes(mux, private)
	filesSvc.Routes(mux, private)
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
		httpx.Observe,
		httpx.Recover,
	)
	return &App{Handler: h, Auth: authSvc, Gateway: hub, Files: filesSvc, RTC: rtcSvc}
}
