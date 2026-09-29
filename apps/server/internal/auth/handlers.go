package auth

import (
	"errors"
	"net/http"
	"strings"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Web clients (ADR-0015) keep the refresh token in an HttpOnly cookie instead of JS memory.
// A request is a web request when it carries "X-Client: web": an explicit opt-in, because
// Sec-Fetch-* headers are also sent by the Electron renderer (Chromium) and would not tell
// the two apart. Desktop behaviour (token in the JSON body) is unchanged.
const (
	RefreshCookie = "calaba_refresh"
	cookiePath    = "/api/auth"
	webHeader     = "X-Client"
)

func isWeb(r *http.Request) bool { return r.Header.Get(webHeader) == "web" }

// IsWeb reports a web-client request (X-Client: web).
func IsWeb(r *http.Request) bool { return isWeb(r) }

// SetRefreshCookie moves the refresh token of t into the calaba_refresh cookie (web).
func SetRefreshCookie(w http.ResponseWriter, t *v1.AuthTokens) { setRefreshCookie(w, t) }

// Handlers exposes the auth REST API.
type Handlers struct {
	svc     *Service
	limiter *redisx.RateLimiter // per client IP: login and register
	account *redisx.RateLimiter // per account (email): login attempts, against distributed guessing
	origins []string            // allowed browser origins (PUBLIC_APP_URL, PUBLIC_APP_URL_ALT)
	cred    *redisx.RateLimiter // per user: password checks of password / email changes
}

// Password checks of an authenticated account: 5 per 15 minutes.
const (
	credBurst     = 5
	credPerMinute = 5.0 / 15
)

// NewHandlers creates the handlers. limiter throttles login/register per client IP,
// account throttles login attempts per email; origins are the web client's origins for the
// CSRF check of cookie requests.
func NewHandlers(svc *Service, limiter, account *redisx.RateLimiter, origins []string) *Handlers {
	return &Handlers{svc: svc, limiter: limiter, account: account, origins: origins,
		cred: redisx.NewRateLimiter(svc.redis, "rl:cred:", credBurst, credPerMinute)}
}

func client(r *http.Request, device string) Client {
	return Client{DeviceName: device, IP: httpx.ClientIP(r.Context()), UserAgent: r.UserAgent(),
		Locale: mail.FromAcceptLanguage(r.Header.Get("Accept-Language"))}
}

var errBadOrigin = httpx.Forbidden("cross-origin request rejected")

// csrf rejects cookie-mode requests that do not come from the web client's origin.
func (h *Handlers) csrf(r *http.Request) error {
	if !httpx.SameOrigin(r, h.origins) {
		return errBadOrigin
	}
	return nil
}

func setRefreshCookie(w http.ResponseWriter, t *v1.AuthTokens) {
	exp := t.GetRefreshExpiresAt().AsTime()
	http.SetCookie(w, &http.Cookie{
		Name: RefreshCookie, Value: t.GetRefreshToken(), Path: cookiePath,
		Expires: exp, MaxAge: int(time.Until(exp).Seconds()),
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
	})
	t.RefreshToken = "" // never exposed to page JavaScript
}

func clearRefreshCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: RefreshCookie, Value: "", Path: cookiePath, MaxAge: -1,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
	})
}

func refreshFromCookie(r *http.Request) string {
	c, err := r.Cookie(RefreshCookie)
	if err != nil {
		return ""
	}
	return c.Value
}

// rateLimit throttles per client IP; like every limiter it fails closed (503 without Redis).
func (h *Handlers) rateLimit(r *http.Request, action string) error {
	return h.limiter.Take(r.Context(), action+":"+httpx.ClientIP(r.Context()))
}

// Public routes (no access token).
func (h *Handlers) Public(mux httpx.Router) {
	mux.Handle("POST /api/auth/register", httpx.HandlerFunc(h.register))
	mux.Handle("POST /api/auth/login", httpx.HandlerFunc(h.login))
	mux.Handle("POST /api/auth/refresh", httpx.HandlerFunc(h.refresh))
	// Logout authenticates itself: access token, or the refresh token (body / cookie).
	mux.Handle("POST /api/auth/logout", httpx.HandlerFunc(h.logout))
	mux.Handle("POST /api/auth/password/forgot", httpx.HandlerFunc(h.forgotPassword))
	mux.Handle("POST /api/auth/password/reset", httpx.HandlerFunc(h.resetPassword))
}

// Private routes; wrap(...) must apply Require.
func (h *Handlers) Private(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/me/sessions", wrap(httpx.HandlerFunc(h.listSessions)))
	mux.Handle("DELETE /api/me/sessions/{id}", wrap(httpx.HandlerFunc(h.revokeSession)))
	mux.Handle("PATCH /api/me/password", wrap(httpx.HandlerFunc(h.changePassword)))
	mux.Handle("PATCH /api/me/email", wrap(httpx.HandlerFunc(h.changeEmail)))
	mux.Handle("POST /api/auth/verify/send", wrap(httpx.HandlerFunc(h.sendVerification)))
	mux.Handle("POST /api/auth/verify", wrap(httpx.HandlerFunc(h.verifyEmail)))
}

func (h *Handlers) register(w http.ResponseWriter, r *http.Request) error {
	if isWeb(r) {
		if err := h.csrf(r); err != nil { // login CSRF: never set a session cookie cross-site
			return err
		}
	}
	if err := h.rateLimit(r, "register"); err != nil {
		return err
	}
	var req v1.RegisterRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	resp, err := h.svc.Register(r.Context(), &req, client(r, req.GetDeviceName()))
	if err != nil {
		return err
	}
	if isWeb(r) {
		setRefreshCookie(w, resp.GetTokens())
	}
	httpx.Write(w, http.StatusCreated, resp)
	return nil
}

func (h *Handlers) login(w http.ResponseWriter, r *http.Request) error {
	if isWeb(r) {
		if err := h.csrf(r); err != nil {
			return err
		}
	}
	if err := h.rateLimit(r, "login"); err != nil {
		return err
	}
	var req v1.LoginRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	// Per-account bucket (also for unknown emails, so it reveals nothing): stops guessing a
	// password from many IPs.
	if err := h.account.Take(r.Context(), strings.ToLower(strings.TrimSpace(req.GetEmail()))); err != nil {
		return err
	}
	resp, err := h.svc.Login(r.Context(), &req, client(r, req.GetDeviceName()))
	if err != nil {
		return err
	}
	if isWeb(r) {
		setRefreshCookie(w, resp.GetTokens())
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

func (h *Handlers) refresh(w http.ResponseWriter, r *http.Request) error {
	var req v1.RefreshRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	tok, cookie := req.GetRefreshToken(), false
	if tok == "" {
		tok, cookie = refreshFromCookie(r), true
		if err := h.csrf(r); err != nil {
			return err
		}
	}
	resp, err := h.svc.Refresh(r.Context(), &v1.RefreshRequest{RefreshToken: tok}, client(r, ""))
	if err != nil {
		if cookie && (errors.Is(err, errInvalidRefresh) || errors.Is(err, errSessionRevoked)) {
			clearRefreshCookie(w) // dead token: stop the browser from resending it
		}
		// errRefreshRace keeps the cookie: a parallel request already stored the new token.
		return err
	}
	if cookie || isWeb(r) {
		setRefreshCookie(w, resp.GetTokens())
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

func (h *Handlers) logout(w http.ResponseWriter, r *http.Request) error {
	var req v1.LogoutRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	switch {
	case HasBearer(r):
		id, err := h.svc.Authenticate(r)
		if err != nil {
			return err
		}
		if err := h.svc.Logout(r.Context(), id, req.GetAllSessions()); err != nil {
			return err
		}
	case req.GetRefreshToken() != "":
		if err := h.svc.LogoutByRefresh(r.Context(), req.GetRefreshToken(), req.GetAllSessions()); err != nil {
			return err
		}
	case refreshFromCookie(r) != "":
		if err := h.csrf(r); err != nil {
			return err
		}
		if err := h.svc.LogoutByRefresh(r.Context(), refreshFromCookie(r), req.GetAllSessions()); err != nil && err != errInvalidRefresh { //nolint:errorlint // sentinel
			return err
		}
	default:
		return httpx.Unauthenticated("missing bearer token or refresh token")
	}
	if refreshFromCookie(r) != "" {
		clearRefreshCookie(w)
	}
	httpx.NoContent(w)
	return nil
}

func (h *Handlers) listSessions(w http.ResponseWriter, r *http.Request) error {
	resp, err := h.svc.ListSessions(r.Context(), MustFromContext(r.Context()))
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

func (h *Handlers) revokeSession(w http.ResponseWriter, r *http.Request) error {
	sid, err := httpx.PathUUID(r, "id", "session")
	if err != nil {
		return err
	}
	if err := h.svc.RevokeSession(r.Context(), MustFromContext(r.Context()).UserID, sid); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}
