package oauthprovider

import (
	"net/http"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func (s *Service) listGrants(w http.ResponseWriter, r *http.Request) {
	p, err := s.ownPrincipal(r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	grants, err := s.c.DB.Q.ListUserOAuthGrants(r.Context(), sqlc.ListUserOAuthGrantsParams{UserID: p.UserID, WorkspaceID: authorityScope(p)})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	out := &v1.ListOAuthGrantsResponse{}
	for _, g := range grants {
		c, err := s.c.DB.Q.GetOAuthClient(r.Context(), sqlc.GetOAuthClientParams{WorkspaceID: g.WorkspaceID, ID: g.ClientID})
		if err != nil {
			writeAPIError(w, err)
			return
		}
		dto := &v1.OAuthGrant{Id: g.ID.String(), WorkspaceId: g.WorkspaceID.String(), ClientName: c.Name, Scopes: g.Scopes, CreatedAt: timestamppb.New(g.CreatedAt), ExpiresAt: timestamppb.New(g.ExpiresAt)}
		if g.RevokedAt != nil {
			dto.RevokedAt = timestamppb.New(*g.RevokedAt)
		}
		out.Grants = append(out.Grants, dto)
	}
	protoResponse(w, http.StatusOK, out)
}
func (s *Service) deleteGrant(w http.ResponseWriter, r *http.Request) {
	if !s.sameOrigin(r) {
		writeAPIError(w, oauthError("invalid_request"))
		return
	}
	p, err := s.ownPrincipal(r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	id, err := uuid.Parse(r.PathValue("grant"))
	if err != nil {
		writeAPIError(w, oauthError("invalid_request"))
		return
	}
	grants, err := s.c.DB.Q.ListUserOAuthGrants(r.Context(), sqlc.ListUserOAuthGrantsParams{UserID: p.UserID, WorkspaceID: authorityScope(p)})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	var chosen *sqlc.OauthGrant
	for _, g := range grants {
		if g.ID == id {
			chosen = &g
			break
		}
	}
	if chosen == nil {
		writeAPIError(w, &protocolError{code: "invalid_request", status: http.StatusNotFound})
		return
	}
	err = s.c.DB.Tx(r.Context(), func(q *sqlc.Queries) error {
		if _, err := q.LockOAuthWorkspace(r.Context(), chosen.WorkspaceID); err != nil {
			return err
		}
		session, err := q.GetSessionForUpdate(r.Context(), p.SessionID)
		if err != nil || session.UserID != p.UserID || session.RevokedAt != nil || !s.c.Now().Before(session.ExpiresAt) || session.AuthorityVersion != p.Version {
			return &protocolError{code: "invalid_token", status: http.StatusUnauthorized}
		}
		if _, err := q.GetOAuthClientForUpdate(r.Context(), sqlc.GetOAuthClientForUpdateParams{WorkspaceID: chosen.WorkspaceID, ID: chosen.ClientID}); err != nil {
			return err
		}
		g, err := q.GetOAuthGrantForUpdate(r.Context(), sqlc.GetOAuthGrantForUpdateParams{WorkspaceID: chosen.WorkspaceID, ID: id, ClientID: chosen.ClientID})
		if err != nil {
			return err
		}
		if g.UserID != p.UserID {
			return oauthError("invalid_request")
		}
		// Revoke consent and all sessions/families for this app, not only the
		// selected row. Losing the paid entitlement does not prevent withdrawal.
		if _, err = q.RevokeOAuthConsent(r.Context(), sqlc.RevokeOAuthConsentParams{WorkspaceID: g.WorkspaceID, UserID: p.UserID, ClientID: g.ClientID}); err != nil {
			return err
		}
		reason := "user_consent_revoked"
		if _, err = q.RevokeWorkspaceOAuthGrants(r.Context(), sqlc.RevokeWorkspaceOAuthGrantsParams{WorkspaceID: g.WorkspaceID, UserID: &p.UserID, ClientID: &g.ClientID, Reason: &reason}); err != nil {
			return err
		}
		return s.invalidate(r.Context(), q, g, reason)
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	headers(w)
	w.WriteHeader(http.StatusNoContent)
}
