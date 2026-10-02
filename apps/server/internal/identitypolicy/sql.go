package identitypolicy

import (
	"context"
	"errors"
	"time"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/google/uuid"
)

// SQLLoader reads session, membership, versions, grants, assurance, and directory status
// in one database statement. For issuance construct it over Queries.WithTx, after locks.
type SQLLoader struct {
	Q      *sqlc.Queries
	Config EntitlementConfig
}

// NewSQLLoader copies trusted edition configuration and binds generated queries.
func NewSQLLoader(q *sqlc.Queries, config EntitlementConfig) *SQLLoader {
	copied := EntitlementConfig{Edition: config.Edition, EnterpriseWorkspaceIDs: map[uuid.UUID]bool{}}
	for id, enabled := range config.EnterpriseWorkspaceIDs {
		copied.EnterpriseWorkspaceIDs[id] = enabled
	}
	return &SQLLoader{Q: q, Config: copied}
}
func timeValue(value *time.Time) time.Time {
	if value == nil {
		return time.Time{}
	}
	return *value
}
func uuidValue(value *uuid.UUID) uuid.UUID {
	if value == nil {
		return uuid.Nil
	}
	return *value
}

// LoadIdentityState reads one coherent database snapshot for the exact session/user/workspace.
func (l *SQLLoader) LoadIdentityState(ctx context.Context, sessionID, userID, workspaceID uuid.UUID) (State, error) {
	if l == nil || l.Q == nil {
		return State{}, errors.New("identity database is unavailable")
	}
	row, err := l.Q.GetIdentityGateState(ctx, sqlc.GetIdentityGateStateParams{SessionID: sessionID, UserID: userID, WorkspaceID: workspaceID})
	if err != nil {
		return State{}, err
	}
	return l.state(row), nil
}
func (l *SQLLoader) state(row sqlc.GetIdentityGateStateRow) State {
	session := row.Session
	s := State{
		Principal: Principal{SessionID: session.ID, UserID: session.UserID, Authority: Authority(session.AuthorityKind),
			WorkspaceID: uuidValue(session.AuthorityWorkspaceID), ConnectionID: uuidValue(session.AuthorityConnectionID),
			LocalAuthenticatedAt: timeValue(session.LocalAuthenticatedAt), RecoveryAuthenticatedAt: timeValue(session.RecoveryAuthenticatedAt),
			ExpiresAt: session.ExpiresAt, Revoked: session.RevokedAt != nil || row.UserDisabled, Version: session.AuthorityVersion, Guest: row.IsGuest, Bot: row.IsBot},
		WorkspaceID: row.WorkspaceID, WorkspaceSuspended: row.WorkspaceSuspended, Member: row.Member, BuiltinRole: row.BuiltinRole,
		Suspended: row.Suspended, AccessVersion: row.AccessVersion, EntitlementVersion: row.EntitlementVersion,
		Policy:        Policy{Mode: Mode(row.PolicyMode), Version: row.PolicyVersion, MaxAge: time.Duration(row.MaxAgeSeconds) * time.Second},
		Connection:    Connection{ID: row.ConnectionID, Version: row.ConnectionVersion, Enabled: row.ConnectionEnabled, Tested: row.ConnectionTested},
		Identity:      Identity{ID: row.IdentityID, ConnectionID: row.ConnectionID, Version: row.IdentityVersion, Active: row.IdentityActive},
		Directory:     Directory{Required: row.DirectoryRequired, Active: row.DirectoryActive, Enabled: row.DirectoryEnabled, ValidUntil: row.DirectoryValidUntil},
		RecoveryReady: row.RecoveryReady, ProductAdminGranted: row.ProductAdminGranted, Grants: map[Feature]Grant{},
	}
	add := func(feature Feature, enabled *bool, source *string, expiry, revoked *time.Time, version int64) {
		if enabled == nil || source == nil {
			return
		}
		until := timeValue(expiry)
		if *source == "cloud_business" && row.PlanValidUntil != nil {
			until = minimum(until, *row.PlanValidUntil)
		}
		s.Grants[feature] = Grant{WorkspaceID: s.WorkspaceID, Feature: feature, Source: *source, Enabled: *enabled,
			PlanEligible: l.Config.Eligible(s.WorkspaceID, *source, row.BusinessEligible), ValidUntil: until, Revoked: revoked != nil, Version: version}
	}
	add(SSO, row.SsoEnabled, row.SsoSource, row.SsoValidUntil, row.SsoRevokedAt, row.SsoVersion)
	add(DirectorySync, row.DirectoryGranted, row.DirectorySource, row.DirectoryGrantValidUntil, row.DirectoryRevokedAt, row.DirectoryGrantVersion)
	add(OAuthProvider, row.OauthEnabled, row.OauthSource, row.OauthValidUntil, row.OauthRevokedAt, row.OauthVersion)
	if row.AssuranceSessionID != nil {
		s.Assurance = &Assurance{SessionID: *row.AssuranceSessionID, WorkspaceID: s.WorkspaceID, UserID: uuidValue(row.AssuranceUserID),
			ConnectionID: uuidValue(row.AssuranceConnectionID), IdentityID: uuidValue(row.AssuranceIdentityID),
			AuthenticatedAt: timeValue(row.AssuranceAuthenticatedAt), ValidUntil: timeValue(row.AssuranceValidUntil), Revoked: row.AssuranceRevokedAt != nil,
			Versions: Versions{Policy: row.AssurancePolicyVersion, Access: row.AssuranceAccessVersion, Connection: row.AssuranceConnectionVersion,
				Identity: row.AssuranceIdentityVersion, Entitlement: row.AssuranceEntitlementVersion, Session: row.AssuranceSessionVersion}}
	}
	return s
}
