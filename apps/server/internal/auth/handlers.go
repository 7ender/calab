package auth

import (
	"net/http"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
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

// Handlers exposes the auth REST API.
type Handlers struct {
	svc     *Service
	limiter *redisx.RateLimiter
	origins []string // allowed browser origins (PUBLIC_APP_URL, PUBLIC_APP_URL_ALT)
}

// NewHandlers creates the handlers; limiter throttles login/register per client IP,
// origins are the web client's origins for the CSRF check of cookie requests.
func NewHandlers(svc *Service, limiter *redisx.RateLimiter, origins []string) *Handlers {
	return &Handlers{svc: svc, limiter: limiter, origins: origins}
}

func client(r *http.Request, device string) Client {
	return Client{DeviceName: device, IP: httpx.ClientIP(r.Context()), UserAgent: r.UserAgent()}
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

// rateLimit fails open on Redis errors: a Redis blip must not lock everyone out of login.
func (h *Handlers) rateLimit(r *http.Request, action string) error {
	ok, err := h.limiter.Allow(r.Context(), action+":"+httpx.ClientIP(r.Context()))
	if err != nil {
		return nil //nolint:nilerr // fail open, see above
	}
	if !ok {
		return httpx.RateLimited()
	}
	return nil
}

// Public routes (no access token).
func (h *Handlers) Public(mux *http.ServeMux) {
	mux.Handle("POST /api/auth/register", httpx.HandlerFunc(h.register))
	mux.Handle("POST /api/auth/login", httpx.HandlerFunc(h.login))
	mux.Handle("POST /api/auth/refresh", httpx.HandlerFunc(h.refresh))
	// Logout authenticates itself: access token, or the refresh token (body / cookie).
	mux.Handle("POST /api/auth/logout", httpx.HandlerFunc(h.logout))
}

// Private routes; wrap(...) must apply Require.
func (h *Handlers) Private(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/me/sessions", wrap(httpx.HandlerFunc(h.listSessions)))
	mux.Handle("DELETE /api/me/sessions/{id}", wrap(httpx.HandlerFunc(h.revokeSession)))
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
		if cookie {
			clearRefreshCookie(w) // dead token: stop the browser from resending it
		}
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
