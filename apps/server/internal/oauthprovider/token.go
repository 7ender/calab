package oauthprovider

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/oauthprovider/signing"
	"github.com/google/uuid"
)

type protocolError struct {
	code   string
	status int
}

func (e *protocolError) Error() string { return "oauthprovider: " + e.code }
func oauthError(code string) error     { return &protocolError{code: code, status: http.StatusBadRequest} }
func invalidClient() error {
	return &protocolError{code: "invalid_client", status: http.StatusUnauthorized}
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
	RefreshToken string `json:"refresh_token,omitempty"`
	IDToken      string `json:"id_token,omitempty"`
}

// authenticateClient checks client credentials. With lock it re-reads the client
// FOR UPDATE, preventing secret rotation or disabling between authentication and
// a transactional issuance. Without lock it is the cheap pre-authentication pass
// that runs before any workspace lock or per-client quota is touched.
func (s *Service) authenticateClient(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, r *http.Request, f url.Values, lock bool) (sqlc.OauthClient, error) {
	id := f.Get("client_id")
	user, secret, basic := r.BasicAuth()
	if r.Header.Get("Authorization") != "" && !basic {
		return sqlc.OauthClient{}, invalidClient()
	}
	if f.Has("client_secret") || f.Has("client_assertion") || f.Has("client_assertion_type") {
		return sqlc.OauthClient{}, invalidClient()
	}
	if basic {
		var err error
		user, err = url.QueryUnescape(user)
		if err != nil {
			return sqlc.OauthClient{}, invalidClient()
		}
		secret, err = url.QueryUnescape(secret)
		if err != nil {
			return sqlc.OauthClient{}, invalidClient()
		}
		if id != "" {
			return sqlc.OauthClient{}, invalidClient()
		}
		id = user
	}
	c, err := q.FindOAuthClient(ctx, sqlc.FindOAuthClientParams{WorkspaceID: ws, ClientID: id})
	if err != nil {
		return c, invalidClient()
	}
	if lock {
		c, err = q.GetOAuthClientForUpdate(ctx, sqlc.GetOAuthClientForUpdateParams{WorkspaceID: ws, ID: c.ID})
		if err != nil {
			return c, err
		}
	}
	if c.DisabledAt != nil {
		return c, invalidClient()
	}
	switch c.AuthMethod {
	case "none":
		if basic || c.ClientType == "confidential_web" {
			return c, invalidClient()
		}
	case "client_secret_basic":
		if !basic || c.ClientType != "confidential_web" || !tokenShape(secret, "calab_os_") {
			return c, invalidClient()
		}
		keys, err := q.ListOAuthClientSecrets(ctx, sqlc.ListOAuthClientSecretsParams{WorkspaceID: ws, ClientID: c.ID})
		if err != nil {
			return c, err
		}
		match := false
		for _, key := range keys {
			match = equalHash(hash(secret), key.SecretHash) || match
		}
		if !match {
			return c, invalidClient()
		}
	default:
		return c, invalidClient()
	}
	return c, nil
}

func (s *Service) checkGrant(ctx context.Context, q *sqlc.Queries, c sqlc.OauthClient, g sqlc.OauthGrant, op identitypolicy.Operation) (identitypolicy.Decision, error) {
	now := s.c.Now()
	if c.DisabledAt != nil || c.WorkspaceID != g.WorkspaceID || c.ID != g.ClientID || g.Issuer != s.issuer(g.WorkspaceID) || g.RevokedAt != nil || !now.Before(g.ExpiresAt) || !now.Before(g.IdleExpiresAt) || c.Version != g.ClientVersion {
		return identitypolicy.Decision{}, oauthError("invalid_grant")
	}
	consent, err := q.GetOAuthConsent(ctx, sqlc.GetOAuthConsentParams{WorkspaceID: g.WorkspaceID, ID: g.ConsentID})
	if err != nil {
		return identitypolicy.Decision{}, err
	}
	if consent.RevokedAt != nil || consent.UserID != g.UserID || consent.ClientID != c.ID || consent.Version != g.ConsentVersion || !subset(g.Scopes, consent.Scopes) {
		return identitypolicy.Decision{}, oauthError("invalid_grant")
	}
	// state locks the matching workspace/user/member/session boundary before
	// loading authority. The composite grant FK and that lock bind the source user.
	_, d, err := s.state(ctx, q, identitypolicy.Principal{SessionID: g.SessionID, UserID: g.UserID}, g.WorkspaceID, op)
	if err != nil {
		return d, oauthError("invalid_grant")
	}
	// Session/member locks may have waited after the first deadline check. Both
	// clocks are read again only after every boundary lock and fresh policy load.
	now = s.c.Now()
	dbNow, err := q.IdentityDatabaseNow(ctx)
	if err != nil {
		return d, err
	}
	if !now.Before(g.ExpiresAt) || !now.Before(g.IdleExpiresAt) || !dbNow.Before(g.ExpiresAt) || !dbNow.Before(g.IdleExpiresAt) || !now.Before(d.ValidUntil) || !dbNow.Before(d.ValidUntil) {
		return d, oauthError("invalid_grant")
	}
	if d.Versions.Policy != g.PolicyVersion || d.Versions.Access != g.AccessVersion || d.Versions.Entitlement != g.EntitlementVersion || d.Versions.Session != g.SessionVersion || g.AssuranceExpiresAt != nil && (!now.Before(*g.AssuranceExpiresAt) || !dbNow.Before(*g.AssuranceExpiresAt)) {
		return d, oauthError("invalid_grant")
	}
	return d, nil
}

func (s *Service) issueTokens(ctx context.Context, q *sqlc.Queries, c sqlc.OauthClient, g sqlc.OauthGrant, nonce string, refresh bool, generation int64, parent *uuid.UUID, d identitypolicy.Decision) (tokenResponse, error) {
	now := s.c.Now().UTC()
	if g.AuthenticatedAt.After(now) {
		return tokenResponse{}, oauthError("invalid_grant")
	}
	dbNow, err := q.IdentityDatabaseNow(ctx)
	if err != nil {
		return tokenResponse{}, err
	}
	deadline := minimum(g.ExpiresAt, d.ValidUntil)
	if g.AssuranceExpiresAt != nil {
		deadline = minimum(deadline, *g.AssuranceExpiresAt)
	}
	until := minimum(minimum(now.Add(identitypolicy.AccessTokenTTL), dbNow.Add(identitypolicy.AccessTokenTTL)), deadline)
	// ID tokens serialize integer seconds. Apply the same actual expiration to
	// opaque access tokens and never round a proof or lifetime deadline upwards.
	until = time.Unix(until.Unix(), 0).UTC()
	if !until.After(now) || !until.After(dbNow) {
		return tokenResponse{}, oauthError("invalid_grant")
	}
	r := tokenResponse{AccessToken: opaque("calab_oa_"), TokenType: "Bearer", ExpiresIn: int64(until.Sub(now) / time.Second), Scope: strings.Join(g.Scopes, " ")}
	_, err = q.CreateOAuthToken(ctx, sqlc.CreateOAuthTokenParams{WorkspaceID: g.WorkspaceID, GrantID: g.ID, UserID: g.UserID, ClientID: c.ID, TokenHash: hash(r.AccessToken), TokenType: "access", Generation: generation, ExpiresAt: until})
	if err != nil {
		return tokenResponse{}, err
	}
	if refresh {
		consent, err := q.GetOAuthConsent(ctx, sqlc.GetOAuthConsentParams{WorkspaceID: g.WorkspaceID, ID: g.ConsentID})
		if err != nil {
			return tokenResponse{}, err
		}
		if !c.RefreshEnabled || !consent.RefreshAllowed {
			return tokenResponse{}, oauthError("invalid_grant")
		}
		r.RefreshToken = opaque("calab_or_")
		_, err = q.CreateOAuthToken(ctx, sqlc.CreateOAuthTokenParams{WorkspaceID: g.WorkspaceID, GrantID: g.ID, UserID: g.UserID, ClientID: c.ID, TokenHash: hash(r.RefreshToken), TokenType: "refresh", Generation: generation, ParentTokenID: parent, ExpiresAt: deadline})
		if err != nil {
			return tokenResponse{}, err
		}
	}
	sub, err := q.GetOAuthSubject(ctx, sqlc.GetOAuthSubjectParams{WorkspaceID: g.WorkspaceID, UserID: g.UserID})
	if err != nil {
		return tokenResponse{}, err
	}
	claims := signing.Claims{Issuer: g.Issuer, Audience: c.ClientID, Subject: sub.Subject, IssuedAt: now, ExpiresAt: until, Nonce: nonce, AuthTime: &g.AuthenticatedAt}
	u, err := q.GetUser(ctx, g.UserID)
	if err != nil {
		return tokenResponse{}, err
	}
	if slices.Contains(g.Scopes, "profile") {
		claims.Name = u.DisplayName
	}
	if slices.Contains(g.Scopes, "email") && u.Email != nil && u.EmailVerifiedAt != nil {
		claims.Email = *u.Email
		verified := true
		claims.EmailVerified = &verified
	}
	signer, err := s.c.SignerForWorkspace(g.WorkspaceID)
	if err != nil || signer == nil {
		return tokenResponse{}, errors.New("oauthprovider: signer unavailable")
	}
	r.IDToken, err = signer.Sign(claims, c.ClientID)
	return r, err
}

// preExchange authenticates the client and finds the presented code or refresh
// token without locks. Only a caller passing it reaches the per-client quota and
// the locking transaction; the transaction re-validates everything.
func (s *Service) preExchange(ctx context.Context, ws uuid.UUID, r *http.Request, f url.Values) (sqlc.OauthClient, uuid.UUID, error) {
	c, err := s.authenticateClient(ctx, s.c.DB.Q, ws, r, f, false)
	if err != nil {
		return c, uuid.Nil, err
	}
	if err = s.checkCORS(r, c); err != nil {
		return c, uuid.Nil, err
	}
	switch f.Get("grant_type") {
	case "authorization_code":
		if !tokenShape(f.Get("code"), "calab_oc_") || !validVerifier(f.Get("code_verifier")) || f.Get("redirect_uri") == "" || f.Has("scope") {
			return c, uuid.Nil, oauthError("invalid_grant")
		}
		challenge := base64.RawURLEncoding.EncodeToString(hash(f.Get("code_verifier")))
		code, err := s.c.DB.Q.FindOAuthCodeForClient(ctx, sqlc.FindOAuthCodeForClientParams{WorkspaceID: ws, ClientID: c.ID, CodeHash: hash(f.Get("code")), RedirectUri: f.Get("redirect_uri"), PkceChallenge: challenge})
		if errors.Is(err, dbNoRows()) {
			return c, uuid.Nil, oauthError("invalid_grant")
		}
		return c, code.UserID, err
	case "refresh_token":
		if !tokenShape(f.Get("refresh_token"), "calab_or_") {
			return c, uuid.Nil, oauthError("invalid_grant")
		}
		t, err := s.c.DB.Q.FindOAuthToken(ctx, sqlc.FindOAuthTokenParams{WorkspaceID: ws, TokenHash: hash(f.Get("refresh_token")), TokenType: "refresh"})
		if errors.Is(err, dbNoRows()) || err == nil && t.ClientID != c.ID {
			return c, uuid.Nil, oauthError("invalid_grant")
		}
		return c, t.UserID, err
	default:
		return c, uuid.Nil, oauthError("unsupported_grant_type")
	}
}

// exchange returns the client once it is authenticated and its CORS origin is
// allowed, so protocol errors after that point stay readable by a registered SPA.
func (s *Service) exchange(ctx context.Context, ws uuid.UUID, r *http.Request, f url.Values) (tokenResponse, *sqlc.OauthClient, error) {
	pre, user, err := s.preExchange(ctx, ws, r, f)
	var allowed *sqlc.OauthClient
	if pre.ID != uuid.Nil && pre.DisabledAt == nil && s.checkCORS(r, pre) == nil {
		allowed = &pre
	}
	if err != nil {
		var pe *protocolError
		if !errors.As(err, &pe) || pe.code == "invalid_client" {
			allowed = nil
		}
		return tokenResponse{}, allowed, err
	}
	if err = s.quota(ctx, "token", ws, pre.ID, user); err != nil {
		return tokenResponse{}, allowed, err
	}
	var out tokenResponse
	var wireErr error
	err = s.c.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if err := s.lockWorkspace(ctx, q, ws); err != nil {
			return err
		}
		c, err := s.authenticateClient(ctx, q, ws, r, f, true)
		if err != nil {
			return err
		}
		if err = s.checkCORS(r, c); err != nil {
			return err
		}
		switch f.Get("grant_type") {
		case "authorization_code":
			if !tokenShape(f.Get("code"), "calab_oc_") || !validVerifier(f.Get("code_verifier")) || f.Get("redirect_uri") == "" || f.Has("scope") {
				return oauthError("invalid_grant")
			}
			challenge := base64.RawURLEncoding.EncodeToString(hash(f.Get("code_verifier")))
			code, err := q.ConsumeOAuthCode(ctx, sqlc.ConsumeOAuthCodeParams{WorkspaceID: ws, ClientID: c.ID, CodeHash: hash(f.Get("code")), RedirectUri: f.Get("redirect_uri"), PkceChallenge: challenge})
			if err != nil {
				if errors.Is(err, dbNoRows()) {
					// Only an authenticated, exactly bound replay can revoke the
					// issued family. Retained consumed codes remain replay evidence
					// after their exchange deadline; no lifetime is extended.
					used, replayErr := q.GetConsumedOAuthCodeForUpdate(ctx, sqlc.GetConsumedOAuthCodeForUpdateParams{WorkspaceID: ws, ClientID: c.ID, CodeHash: hash(f.Get("code")), RedirectUri: f.Get("redirect_uri"), PkceChallenge: challenge})
					if replayErr != nil {
						if errors.Is(replayErr, dbNoRows()) {
							return oauthError("invalid_grant")
						}
						return replayErr
					}
					g, replayErr := q.GetOAuthGrantForUpdate(ctx, sqlc.GetOAuthGrantForUpdateParams{WorkspaceID: ws, ID: used.GrantID, ClientID: c.ID})
					if replayErr != nil {
						return replayErr
					}
					if replayErr = s.revokeGrant(ctx, q, g, "authorization_code_reuse"); replayErr != nil {
						return replayErr
					}
					// Returning an error from the transaction would undo revocation.
					wireErr = oauthError("invalid_grant")
					return nil
				}
				return err
			}
			g, err := q.GetOAuthGrantForUpdate(ctx, sqlc.GetOAuthGrantForUpdateParams{WorkspaceID: ws, ID: code.GrantID, ClientID: c.ID})
			if err != nil {
				return err
			}
			d, err := s.checkGrant(ctx, q, c, g, identitypolicy.OAuthExchange)
			if err != nil {
				if revokeErr := s.revokeGrant(ctx, q, g, "identity_access_lost"); revokeErr != nil {
					return revokeErr
				}
				wireErr = oauthError("invalid_grant")
				return nil
			}
			dbNow, err := q.IdentityDatabaseNow(ctx)
			if err != nil {
				return err
			}
			if !s.c.Now().Before(code.ExpiresAt) || !dbNow.Before(code.ExpiresAt) {
				if err = s.revokeGrant(ctx, q, g, "authorization_code_expired"); err != nil {
					return err
				}
				wireErr = oauthError("invalid_grant")
				return nil
			}
			consent, err := q.GetOAuthConsent(ctx, sqlc.GetOAuthConsentParams{WorkspaceID: ws, ID: g.ConsentID})
			if err != nil {
				return err
			}
			out, err = s.issueTokens(ctx, q, c, g, code.Nonce, c.RefreshEnabled && consent.RefreshAllowed, 1, nil, d)
			return err
		case "refresh_token":
			if !tokenShape(f.Get("refresh_token"), "calab_or_") {
				return oauthError("invalid_grant")
			}
			t, err := q.GetOAuthTokenForUpdate(ctx, sqlc.GetOAuthTokenForUpdateParams{WorkspaceID: ws, ClientID: c.ID, TokenHash: hash(f.Get("refresh_token")), TokenType: "refresh"})
			if err != nil {
				if errors.Is(err, dbNoRows()) {
					return oauthError("invalid_grant")
				}
				return err
			}
			g, err := q.GetOAuthGrantForUpdate(ctx, sqlc.GetOAuthGrantForUpdateParams{WorkspaceID: ws, ID: t.GrantID, ClientID: c.ID})
			if err != nil {
				return err
			}
			// Replay revocation must commit even though the HTTP response is an error.
			if t.UsedAt != nil {
				if g.RevokedAt == nil {
					g, err = q.RevokeOAuthGrantForReplay(ctx, sqlc.RevokeOAuthGrantForReplayParams{WorkspaceID: ws, ClientID: c.ID, TokenHash: t.TokenHash})
					if err != nil {
						return err
					}
					if err = s.auditGrant(ctx, q, g, "refresh_reuse"); err != nil {
						return err
					}
				}
				wireErr = oauthError("invalid_grant")
				return nil
			}
			d, err := s.checkGrant(ctx, q, c, g, identitypolicy.OAuthRefresh)
			if err != nil {
				if revokeErr := s.revokeGrant(ctx, q, g, "identity_access_lost"); revokeErr != nil {
					return revokeErr
				}
				wireErr = oauthError("invalid_grant")
				return nil
			}
			if t.RevokedAt != nil || !s.c.Now().Before(t.ExpiresAt) || !c.RefreshEnabled {
				return oauthError("invalid_grant")
			}
			if f.Has("scope") {
				scopes, ok := scopeSet(f.Get("scope"))
				if !ok || !subset(scopes, g.Scopes) {
					return oauthError("invalid_scope")
				}
				g, err = q.NarrowOAuthGrantScopes(ctx, sqlc.NarrowOAuthGrantScopesParams{WorkspaceID: ws, ID: g.ID, ClientID: c.ID, Scopes: scopes})
				if err != nil {
					return oauthError("invalid_grant")
				}
			}
			_, err = q.ConsumeOAuthRefresh(ctx, sqlc.ConsumeOAuthRefreshParams{WorkspaceID: ws, ClientID: c.ID, TokenHash: t.TokenHash})
			if err != nil {
				return oauthError("invalid_grant")
			}
			touched, err := q.TouchOAuthGrant(ctx, sqlc.TouchOAuthGrantParams{WorkspaceID: ws, ID: g.ID, ClientID: c.ID})
			if err != nil {
				return err
			}
			g.IdleExpiresAt = touched.IdleExpiresAt
			out, err = s.issueTokens(ctx, q, c, g, "", true, t.Generation+1, &t.ID, d)
			return err
		default:
			return oauthError("unsupported_grant_type")
		}
	})
	if err != nil {
		return tokenResponse{}, allowed, err
	}
	if wireErr != nil {
		return tokenResponse{}, allowed, wireErr
	}
	return out, allowed, nil
}
