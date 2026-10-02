package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/google/uuid"
)

// Provider pre-authentication limits are keyed by the trusted client IP only and
// never touch the database, so an anonymous flood costs one Valkey call and cannot
// spend an authenticated client's budget. Per-(client,user) buckets are charged by
// the provider itself after it authenticated the client and found a live code,
// refresh or access token (providerClientQuota). Parsing here only selects a
// bucket: provider handlers keep all credential/CORS/policy validation.
func providerQuotas(d Deps, a *auth.Service) func(string, *http.Request) error {
	tokenIP := redisx.NewRateLimiter(d.Redis, "rl:oauth:token-ip:", 120, 120)
	tokenClientIP := redisx.NewRateLimiter(d.Redis, "rl:oauth:token-client-ip:", 60, 60)
	authorizeIP := redisx.NewRateLimiter(d.Redis, "rl:oauth:authorize-ip:", 60, 60)
	userinfoIP := redisx.NewRateLimiter(d.Redis, "rl:oauth:userinfo-ip:", 600, 600)
	revokeIP := redisx.NewRateLimiter(d.Redis, "rl:oauth:revoke-ip:", 120, 120)
	publicIP := redisx.NewRateLimiter(d.Redis, "rl:oauth:public-ip:", 120, 120)
	management := redisx.NewRateLimiter(d.Redis, "rl:oauth:management-user:", 30, 30)
	return func(pattern string, r *http.Request) error {
		ip := httpx.ClientIP(r.Context())
		switch {
		case strings.HasSuffix(pattern, "/token"):
			if err := tokenIP.Take(r.Context(), ip); err != nil {
				return err
			}
			id, err := quotaFormClientID(r)
			if err != nil || id == "" {
				return err
			}
			// Public clients have no secret: one IP must not drain a shared NAT's
			// token budget for every other client behind it.
			return tokenClientIP.Take(r.Context(), base64.RawURLEncoding.EncodeToString(quotaHash(id)[:16])+":"+ip)
		case strings.HasSuffix(pattern, "/userinfo"):
			return userinfoIP.Take(r.Context(), ip)
		case strings.HasSuffix(pattern, "/revoke"):
			return revokeIP.Take(r.Context(), ip)
		case strings.HasSuffix(pattern, "/authorize"):
			return authorizeIP.Take(r.Context(), ip)
		case strings.HasPrefix(pattern, "OPTIONS "), strings.HasSuffix(pattern, "/jwks"), strings.Contains(pattern, "/.well-known/"):
			return publicIP.Take(r.Context(), ip)
		case strings.HasPrefix(r.URL.Path, "/api/"):
			if !auth.HasBearer(r) {
				return nil
			} // handlers return their typed 401
			id, err := a.Authenticate(r)
			if err != nil {
				return quotaSessionError(err)
			}
			p, err := a.ResolvePrincipal(r.Context(), id)
			if err != nil {
				return quotaSessionError(err)
			}
			return management.Take(r.Context(), p.UserID.String())
		}
		return nil
	}
}

// providerClientQuota is the provider's post-authentication hook. Buckets are per
// (client,user), so a client's budget grows with its active users and one user
// (or a leaked token) cannot starve the rest; a legitimate RP refreshes about
// once per access-token lifetime (5 min) per user.
func providerClientQuota(d Deps) func(context.Context, string, uuid.UUID, uuid.UUID, uuid.UUID) error {
	token := redisx.NewRateLimiter(d.Redis, "rl:oauth:token-client-user:", 30, 30)
	userinfo := redisx.NewRateLimiter(d.Redis, "rl:oauth:userinfo-client-user:", 60, 60)
	return func(ctx context.Context, endpoint string, ws, client, user uuid.UUID) error {
		key := ws.String() + ":" + client.String() + ":" + user.String()
		switch endpoint {
		case "token":
			return token.Take(ctx, key)
		case "userinfo":
			return userinfo.Take(ctx, key)
		}
		return nil
	}
}

// quotaFormClientID returns the form client_id of an unauthenticated (public)
// token request, restoring the exact body for the provider. Basic-authenticated
// requests and unusable forms select no client bucket; oversized or ambiguous
// forms receive the provider parser's error early.
func quotaFormClientID(r *http.Request) (string, error) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/x-www-form-urlencoded" || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "" {
		return "", nil
	}
	original := r.Body
	if original == nil {
		return "", nil
	}
	raw, err := io.ReadAll(io.LimitReader(original, (16<<10)+1))
	_ = original.Close()
	r.Body = io.NopCloser(bytes.NewReader(raw))
	if err != nil || len(raw) > 16<<10 {
		return "", httpx.BadRequest("invalid OAuth form")
	}
	f, err := url.ParseQuery(string(raw))
	if err != nil {
		return "", httpx.BadRequest("invalid OAuth form")
	}
	for _, values := range f {
		if len(values) != 1 || len(values[0]) > 4096 {
			return "", httpx.BadRequest("invalid OAuth form")
		}
	}
	if f.Has("client_secret") || f.Has("client_assertion") || f.Has("client_assertion_type") {
		return "", nil
	}
	return f.Get("client_id"), nil
}
func quotaHash(raw string) []byte { v := sha256.Sum256([]byte(raw)); return v[:] }

func quotaSessionError(err error) error {
	if errors.Is(err, auth.ErrInvalidToken) || errors.Is(err, auth.ErrSessionRevoked) {
		return httpx.Unauthenticated("invalid session")
	}
	e := httpx.Coded(503, v1.ErrorCode_ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE, "identity dependency unavailable")
	e.Err = err
	return e
}
