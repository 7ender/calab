package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/superadmin"
	"github.com/google/uuid"
)

// SessionPrincipal converts only authoritative persisted session fields.
func SessionPrincipal(s sqlc.Session) identitypolicy.Principal {
	p := identitypolicy.Principal{UserID: s.UserID, SessionID: s.ID, Authority: identitypolicy.Authority(s.AuthorityKind), ExpiresAt: s.ExpiresAt, Revoked: s.RevokedAt != nil, Version: s.AuthorityVersion}
	if s.AuthorityWorkspaceID != nil {
		p.WorkspaceID = *s.AuthorityWorkspaceID
	}
	if s.AuthorityConnectionID != nil {
		p.ConnectionID = *s.AuthorityConnectionID
	}
	if s.LocalAuthenticatedAt != nil {
		p.LocalAuthenticatedAt = *s.LocalAuthenticatedAt
	}
	if s.RecoveryAuthenticatedAt != nil {
		p.RecoveryAuthenticatedAt = *s.RecoveryAuthenticatedAt
	}
	return p
}

// ResolvePrincipal loads the exact session/user pair. Background consumers never infer
// authority from a user ID or the user's other sessions.
func (s *Service) ResolvePrincipal(ctx context.Context, id Identity) (identitypolicy.Principal, error) {
	if id.IsBot {
		return identitypolicy.Principal{UserID: id.UserID, SessionID: id.SessionID, Bot: true}, nil
	}
	row, err := s.db.Q.GetSession(ctx, id.SessionID)
	if db.IsNotFound(err) {
		return identitypolicy.Principal{}, ErrSessionRevoked
	}
	if err != nil {
		return identitypolicy.Principal{}, err
	}
	p := SessionPrincipal(row)
	if p.UserID != id.UserID || !identitypolicy.CheckSession(s.now(), p).Allowed {
		return p, ErrSessionRevoked
	}
	return p, nil
}

// IdentityError translates the frozen decision without exposing workspace content.
func IdentityError(p identitypolicy.Principal, d identitypolicy.Decision, err error) error {
	if d.Allowed && err == nil {
		return nil
	}
	if d.Reason == identitypolicy.StateUnavailable || (err != nil && !errors.Is(err, identitypolicy.ErrDenied)) {
		e := httpx.Coded(http.StatusServiceUnavailable, v1.ErrorCode_ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE, "identity dependency unavailable")
		e.Err = err
		return e
	}
	if d.Reason == identitypolicy.InvalidSession {
		return httpx.Unauthenticated("session invalid")
	}
	code := v1.ErrorCode_ERROR_CODE_IDENTITY_SCOPE_DENIED
	switch d.Reason {
	case identitypolicy.SSORequired:
		code = v1.ErrorCode_ERROR_CODE_SSO_REQUIRED
	case identitypolicy.DirectoryStale:
		code = v1.ErrorCode_ERROR_CODE_DIRECTORY_ACCESS_DENIED
	case identitypolicy.EntitlementRequired:
		return httpx.Conflict("identity entitlement required").WithDetails(httpx.ReasonPlanLimit, 0, 0)
	case identitypolicy.MembershipRequired:
		return httpx.NotFound("workspace")
	case identitypolicy.WorkspaceSuspended:
		return httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED, "workspace suspended")
	}
	if p.Authority == identitypolicy.Recovery {
		code = v1.ErrorCode_ERROR_CODE_RECOVERY_ONLY
	}
	return httpx.Coded(http.StatusForbidden, code, "identity access denied")
}

// CheckWorkspace supplements resource permissions with fresh database policy state.
func (s *Service) CheckWorkspace(ctx context.Context, id Identity, ws uuid.UUID, op identitypolicy.Operation) error {
	if id.IsBot {
		suspended, err := s.db.Q.WorkspaceSuspended(ctx, ws)
		if err != nil {
			return httpx.Unavailable(err)
		}
		if suspended {
			return httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED, "workspace suspended")
		}
		return nil // existing machine route/permission gates remain mandatory
	}
	d, err := s.Policy.CheckWorkspace(ctx, identitypolicy.Principal{UserID: id.UserID, SessionID: id.SessionID}, ws, op)
	return IdentityError(id.Principal, d, err)
}

// CheckGlobal requires independent local authority. Product administration additionally
// accepts a durable operator UUID grant or the explicitly configured legacy email source.
func (s *Service) CheckGlobal(ctx context.Context, id Identity, op identitypolicy.Operation) error {
	if id.IsBot {
		return ErrBotNotAllowed
	}
	p := id.Principal
	if p.SessionID == uuid.Nil {
		var err error
		p, err = s.ResolvePrincipal(ctx, id)
		if err != nil {
			return err
		}
	}
	granted := false
	if op == identitypolicy.ProductAdmin {
		// Admin checks are fresh, including local reauthentication and revocation.
		var err error
		p, err = s.ResolvePrincipal(ctx, id)
		if err != nil {
			return err
		}
		grant, gerr := s.db.Q.GetProductAdminGrant(ctx, id.UserID)
		if gerr != nil && !db.IsNotFound(gerr) {
			return httpx.Unavailable(gerr)
		}
		granted = gerr == nil && grant.RevokedAt == nil
		u, uerr := s.db.Q.GetUser(ctx, id.UserID)
		if uerr != nil {
			return uerr
		}
		granted = !u.IsGuest && !u.IsBot && u.DisabledAt == nil && (granted || (u.EmailVerifiedAt != nil && superadmin.IsPtr(u.Email)))
	}
	d := identitypolicy.CheckGlobal(s.now(), p, op, granted)
	return IdentityError(p, d, nil)
}

// WithPolicy installs a request-local gate used by every nested resource resolution.
func (s *Service) WithPolicy(ctx context.Context, id Identity, op identitypolicy.Operation) context.Context {
	return perm.WithAccessGuard(ctx, func(ctx context.Context, ws, user uuid.UUID) error {
		// A handler may resolve another member's permissions; authority still belongs to caller.
		if ws == uuid.Nil {
			if id.IsBot {
				return nil
			}
			return s.CheckGlobal(ctx, id, identitypolicy.GlobalRead)
		}
		return s.CheckWorkspace(ctx, id, ws, op)
	})
}

// LocalReauthenticate proves the existing local credential without creating SSO assurance.
func (s *Service) LocalReauthenticate(ctx context.Context, id Identity, password string) (time.Time, error) {
	if err := s.CheckGlobal(ctx, id, identitypolicy.GlobalWrite); err != nil {
		return time.Time{}, err
	}
	u, err := s.db.Q.GetUser(ctx, id.UserID)
	if err != nil {
		return time.Time{}, err
	}
	valid, err := VerifyPassword(ctx, password, deref(u.PasswordHash))
	if err != nil {
		return time.Time{}, err
	}
	if u.IsGuest || u.IsBot || !valid {
		return time.Time{}, httpx.Unauthenticated("invalid credentials")
	}
	at := s.now()
	if _, err = s.db.Q.RecordLocalAuthentication(ctx, sqlc.RecordLocalAuthenticationParams{SessionID: id.SessionID, UserID: id.UserID, AuthenticatedAt: &at}); err != nil {
		return time.Time{}, err
	}
	liveSessions.drop(id.SessionID)
	return at, nil
}

// CheckAdmission protects the narrow membership bootstrap. It never mints assurance and
// refuses legacy admission capabilities when SSO is required.
func (s *Service) CheckAdmission(ctx context.Context, id Identity, ws uuid.UUID) error {
	if err := s.CheckGlobal(ctx, id, identitypolicy.GlobalWrite); err != nil {
		return err
	}
	return CheckPublicCapability(ctx, s.db.Q, ws)
}

// CheckPublicCapability checks a public link against the workspace's durable policy.
// Missing policy rows are the migration's explicit legacy off default; database errors deny.
func CheckPublicCapability(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) error {
	policy, err := q.GetIdentityPolicy(ctx, ws)
	if err != nil && !db.IsNotFound(err) {
		return httpx.Unavailable(err)
	}
	if err == nil && policy.Mode == string(identitypolicy.Enforced) {
		return httpx.Coded(403, v1.ErrorCode_ERROR_CODE_SSO_REQUIRED, "organization sign-in required")
	}
	if err == nil && policy.Mode != string(identitypolicy.Off) && policy.Mode != string(identitypolicy.Optional) {
		return httpx.Forbidden("invalid identity policy")
	}
	return nil
}

// IssueIdentityTokens is the trusted RP issuer hook. The RP has created the session and
// assurance in q's transaction; origin, user, expiry and refresh hash are checked again.
func (s *Service) IssueIdentityTokens(ctx context.Context, q *sqlc.Queries, session sqlc.Session, secret string) (*v1.AuthTokens, error) {
	row, err := q.GetSession(ctx, session.ID)
	if err != nil {
		return nil, err
	}
	if row.UserID != session.UserID || row.AuthorityKind != session.AuthorityKind || !identitypolicy.CheckSession(s.now(), SessionPrincipal(row)).Allowed || subtle.ConstantTimeCompare(row.RefreshTokenHash, HashRefreshSecret(secret)) != 1 {
		return nil, ErrInvalidToken
	}
	return s.tokenPair(row, secret)
}
