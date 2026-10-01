package oauthprovider

import (
	"context"
	"errors"
	"net/http"
	"slices"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
)

func (s *Service) userinfo(w http.ResponseWriter, r *http.Request) {
	ws, err := pathWorkspace(r)
	if err != nil {
		writeError(w, err)
		return
	}
	raw := bearer(r)
	invalid := &protocolError{code: "invalid_token", status: http.StatusUnauthorized}
	if !tokenShape(raw, "calab_oa_") || r.URL.RawQuery != "" {
		writeError(w, invalid)
		return
	}
	out := map[string]any{}
	var wireErr error
	err = s.c.DB.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := s.lockWorkspace(r.Context(), q, ws); err != nil {
			return err
		}
		t, err := q.FindOAuthToken(r.Context(), sqlc.FindOAuthTokenParams{WorkspaceID: ws, TokenHash: hash(raw), TokenType: "access"})
		if err != nil {
			return invalid
		}
		c, err := q.GetOAuthClientForUpdate(r.Context(), sqlc.GetOAuthClientForUpdateParams{WorkspaceID: ws, ID: t.ClientID})
		if err != nil {
			return invalid
		}
		if err = s.checkCORS(r, c); err != nil {
			return err
		}
		g, err := q.GetOAuthGrantForUpdate(r.Context(), sqlc.GetOAuthGrantForUpdateParams{WorkspaceID: ws, ID: t.GrantID, ClientID: t.ClientID})
		if err != nil {
			return invalid
		}
		if _, err = s.checkGrant(r.Context(), q, c, g, identitypolicy.OAuthUserInfo); err != nil {
			if err = s.revokeGrant(r.Context(), q, g, "identity_access_lost"); err != nil {
				return err
			}
			wireErr = invalid
			return nil
		}
		if t.RevokedAt != nil || !s.c.Now().Before(t.ExpiresAt) {
			return invalid
		}
		sub, err := q.GetOAuthSubject(r.Context(), sqlc.GetOAuthSubjectParams{WorkspaceID: ws, UserID: g.UserID})
		if err != nil {
			return err
		}
		u, err := q.GetUser(r.Context(), g.UserID)
		if err != nil {
			return err
		}
		out["sub"] = sub.Subject
		if slices.Contains(g.Scopes, "profile") {
			out["name"] = u.DisplayName
		}
		if slices.Contains(g.Scopes, "email") && u.Email != nil && u.EmailVerifiedAt != nil {
			out["email"] = *u.Email
			out["email_verified"] = true
		}
		return nil
	})
	if err != nil {
		writeError(w, err)
		return
	}
	if wireErr != nil {
		writeError(w, wireErr)
		return
	}
	cors(w, r)
	jsonResponse(w, http.StatusOK, out)
}

func (s *Service) revoke(w http.ResponseWriter, r *http.Request) {
	ws, err := pathWorkspace(r)
	if err != nil {
		writeError(w, err)
		return
	}
	f, err := form(w, r)
	if err != nil {
		writeError(w, err)
		return
	}
	if f.Get("token") == "" {
		writeError(w, oauthError("invalid_request"))
		return
	}
	err = s.c.DB.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := s.lockWorkspace(r.Context(), q, ws); err != nil {
			return err
		}
		c, err := s.authenticateClient(r.Context(), q, ws, r, f)
		if err != nil {
			return err
		}
		if err = s.checkCORS(r, c); err != nil {
			return err
		}
		kind := ""
		if tokenShape(f.Get("token"), "calab_oa_") {
			kind = "access"
		}
		if tokenShape(f.Get("token"), "calab_or_") {
			kind = "refresh"
		}
		if kind == "" {
			return nil
		}
		t, err := q.GetOAuthTokenForUpdate(r.Context(), sqlc.GetOAuthTokenForUpdateParams{WorkspaceID: ws, ClientID: c.ID, TokenHash: hash(f.Get("token")), TokenType: kind})
		if errors.Is(err, dbNoRows()) {
			return nil
		}
		if err != nil {
			return err
		}
		g, err := q.GetOAuthGrantForUpdate(r.Context(), sqlc.GetOAuthGrantForUpdateParams{WorkspaceID: ws, ID: t.GrantID, ClientID: c.ID})
		if err != nil {
			return err
		}
		return s.revokeGrant(r.Context(), q, g, "oauth_revoke")
	})
	if err != nil {
		writeError(w, err)
		return
	}
	cors(w, r)
	headers(w)
	w.WriteHeader(http.StatusOK)
}

func (s *Service) revokeGrant(ctx context.Context, q *sqlc.Queries, g sqlc.OauthGrant, reason string) error {
	if g.RevokedAt != nil {
		return nil
	}
	_, err := q.RevokeOAuthGrant(ctx, sqlc.RevokeOAuthGrantParams{WorkspaceID: g.WorkspaceID, ID: g.ID, UserID: g.UserID, RevokedReason: &reason})
	if err != nil {
		return err
	}
	return s.invalidate(ctx, q, g, reason)
}

func (s *Service) ownPrincipal(r *http.Request) (identitypolicy.Principal, error) {
	p, err := s.resolveBearer(r)
	if err != nil {
		return p, apiSessionError(err)
	}
	if !identitypolicy.CheckSession(s.c.Now(), p).Allowed || p.Guest || p.Bot {
		return p, &protocolError{code: "invalid_token", status: http.StatusUnauthorized}
	}
	session, err := s.c.DB.Q.GetSession(r.Context(), p.SessionID)
	if err != nil {
		return p, apiSessionError(err)
	}
	if session.UserID != p.UserID || session.RevokedAt != nil || !s.c.Now().Before(session.ExpiresAt) || session.AuthorityVersion != p.Version || session.AuthorityKind != string(p.Authority) {
		return p, &protocolError{code: "invalid_token", status: http.StatusUnauthorized}
	}
	u, err := s.c.DB.Q.GetUser(r.Context(), p.UserID)
	if err != nil {
		return p, apiSessionError(err)
	}
	if u.DisabledAt != nil || u.IsGuest || u.IsBot {
		return p, &protocolError{code: "invalid_token", status: http.StatusUnauthorized}
	}
	if p.Authority == identitypolicy.WorkspaceSSO && (session.AuthorityWorkspaceID == nil || *session.AuthorityWorkspaceID != p.WorkspaceID) {
		return p, &protocolError{code: "invalid_token", status: http.StatusUnauthorized}
	}
	now, err := s.policyNow(r.Context(), s.c.DB.Q)
	if err != nil {
		return p, err
	}
	if !now.Before(session.ExpiresAt) {
		return p, &protocolError{code: "invalid_token", status: http.StatusUnauthorized}
	}
	if p.Authority == identitypolicy.Recovery {
		return p, apiIdentityError(identitypolicy.State{Principal: p}, identitypolicy.Decision{}, identitypolicy.ErrDenied)
	}
	return p, nil
}

// authorityScope grants local accounts their own grants; SSO sees only its issuer.
func authorityScope(p identitypolicy.Principal) *uuid.UUID {
	if p.Authority == identitypolicy.WorkspaceSSO {
		return &p.WorkspaceID
	}
	return nil
}
