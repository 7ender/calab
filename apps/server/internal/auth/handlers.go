package auth

import (
	"net/http"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Handlers exposes the auth REST API.
type Handlers struct {
	svc     *Service
	limiter *redisx.RateLimiter
}

// NewHandlers creates the handlers; limiter throttles login/register per client IP.
func NewHandlers(svc *Service, limiter *redisx.RateLimiter) *Handlers {
	return &Handlers{svc: svc, limiter: limiter}
}

func client(r *http.Request, device string) Client {
	return Client{DeviceName: device, IP: httpx.ClientIP(r.Context()), UserAgent: r.UserAgent()}
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
}

// Private routes; wrap(...) must apply Require.
func (h *Handlers) Private(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /api/auth/logout", wrap(httpx.HandlerFunc(h.logout)))
	mux.Handle("GET /api/me/sessions", wrap(httpx.HandlerFunc(h.listSessions)))
	mux.Handle("DELETE /api/me/sessions/{id}", wrap(httpx.HandlerFunc(h.revokeSession)))
}

func (h *Handlers) register(w http.ResponseWriter, r *http.Request) error {
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
	httpx.Write(w, http.StatusCreated, resp)
	return nil
}

func (h *Handlers) login(w http.ResponseWriter, r *http.Request) error {
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
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

func (h *Handlers) refresh(w http.ResponseWriter, r *http.Request) error {
	var req v1.RefreshRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	resp, err := h.svc.Refresh(r.Context(), &req, client(r, ""))
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

func (h *Handlers) logout(w http.ResponseWriter, r *http.Request) error {
	var req v1.LogoutRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if err := h.svc.Logout(r.Context(), MustFromContext(r.Context()), req.GetAllSessions()); err != nil {
		return err
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
