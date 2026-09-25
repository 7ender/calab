package auth

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/calaba/calaba/server/internal/httpx"
)

type ctxKey struct{}

// FromContext returns the request identity; ok=false on unauthenticated routes.
func FromContext(ctx context.Context) (Identity, bool) {
	id, ok := ctx.Value(ctxKey{}).(Identity)
	return id, ok
}

// MustFromContext returns the identity or panics (wiring bug: route not behind Require).
func MustFromContext(ctx context.Context) Identity {
	id, ok := FromContext(ctx)
	if !ok {
		panic("auth: no identity in context")
	}
	return id
}

// WithIdentity stores id in ctx (tests, gateway).
func WithIdentity(ctx context.Context, id Identity) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// Require authenticates `Authorization: Bearer <access JWT>` and rejects revoked sessions.
// Redis failure fails closed (503): a revoked session must not slip through.
func (s *Service) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := s.Authenticate(r)
		if err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), id)))
	})
}

// HasBearer reports whether the request carries an Authorization bearer token.
func HasBearer(r *http.Request) bool {
	return strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ")
}

// Authenticate validates the bearer access token of r.
func (s *Service) Authenticate(r *http.Request) (Identity, error) {
	tok, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !found || tok == "" {
		return Identity{}, httpx.Unauthenticated("missing bearer token")
	}
	id, err := s.tokens.Parse(tok)
	if err != nil {
		return Identity{}, httpx.Unauthenticated("invalid or expired access token")
	}
	revoked, err := s.IsRevoked(r.Context(), id.SessionID)
	if err != nil {
		slog.ErrorContext(r.Context(), "revocation check failed", "err", err)
		return Identity{}, httpx.Unavailable(err)
	}
	if revoked {
		return Identity{}, httpx.Unauthenticated("session revoked")
	}
	return id, nil
}
