package sso

import (
	"context"
	"time"
	"unicode/utf8"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func provider(v pb.IdentityProvider) string {
	switch v {
	case pb.IdentityProvider_IDENTITY_PROVIDER_ENTRA:
		return "entra"
	case pb.IdentityProvider_IDENTITY_PROVIDER_ADFS:
		return "adfs"
	case pb.IdentityProvider_IDENTITY_PROVIDER_GENERIC:
		return "generic"
	}
	return ""
}

// ConnectionView redacts the encrypted secret at the service boundary.
func ConnectionView(c sqlc.WorkspaceIdentityConnection) *pb.IdentityConnection {
	providers := map[string]pb.IdentityProvider{"entra": pb.IdentityProvider_IDENTITY_PROVIDER_ENTRA, "adfs": pb.IdentityProvider_IDENTITY_PROVIDER_ADFS, "generic": pb.IdentityProvider_IDENTITY_PROVIDER_GENERIC}
	statuses := map[string]pb.IdentityConnectionStatus{"draft": pb.IdentityConnectionStatus_IDENTITY_CONNECTION_STATUS_DRAFT, "tested": pb.IdentityConnectionStatus_IDENTITY_CONNECTION_STATUS_TESTED, "active": pb.IdentityConnectionStatus_IDENTITY_CONNECTION_STATUS_ACTIVE, "disabled": pb.IdentityConnectionStatus_IDENTITY_CONNECTION_STATUS_DISABLED}
	out := &pb.IdentityConnection{Id: c.ID.String(), WorkspaceId: c.WorkspaceID.String(), Name: c.Name, Provider: providers[c.Provider], Issuer: c.Issuer, TenantId: c.TenantID, ClientId: c.ClientID, SecretConfigured: len(c.ClientSecretBox) > 0, Version: uint64(c.Version), Status: statuses[c.Status]}
	if c.TestedAt != nil {
		out.TestedAt = timestamppb.New(*c.TestedAt)
	}
	return out
}
func (s *Service) manage(ctx context.Context, q *sqlc.Queries, p identitypolicy.Principal, ws uuid.UUID) (identitypolicy.State, error) {
	if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
		return identitypolicy.State{}, err
	}
	if _, err := q.EnsureIdentityPolicy(ctx, ws); err != nil {
		return identitypolicy.State{}, err
	}
	st, err := s.state(ctx, q, p, ws)
	if err != nil {
		return st, err
	}
	if !identitypolicy.Evaluate(s.now(), st, identitypolicy.ManageSSO).Allowed {
		return st, ErrDenied
	}
	return st, nil
}

func ownerTestAllowed(now time.Time, st identitypolicy.State) bool {
	st.Policy.Mode = identitypolicy.Optional
	st.Directory.Required = false
	return identitypolicy.Evaluate(now, st, identitypolicy.ManageSSO).Allowed
}

// PutConnection updates credentials under CAS; immutable issuer changes create a fresh draft.
func (s *Service) PutConnection(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID, req *pb.PutIdentityConnectionRequest) (*pb.IdentityConnection, error) {
	if req == nil || utf8.RuneCountInString(req.Name) < 1 || utf8.RuneCountInString(req.Name) > 100 || len(req.ClientId) > 512 || (req.ClientSecret != nil && (*req.ClientSecret == "" || len(*req.ClientSecret) > 8192)) {
		return nil, ErrInvalid
	}
	candidate := sqlc.WorkspaceIdentityConnection{WorkspaceID: ws, Name: req.Name, Provider: provider(req.Provider), Issuer: req.Issuer, TenantID: req.TenantId, ClientID: req.ClientId, Status: "draft", Version: 1, Scopes: []string{"openid"}}
	if !validIssuer(candidate) {
		return nil, ErrInvalid
	}
	var out *pb.IdentityConnection
	err := s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := s.manage(ctx, q, p, ws); err != nil {
			return err
		}
		all, err := q.ListIdentityConnections(ctx, ws)
		if err != nil {
			return err
		}
		var previous *sqlc.WorkspaceIdentityConnection
		for i := len(all) - 1; i >= 0; i-- {
			if all[i].DisabledAt == nil {
				previous = &all[i]
				break
			}
		}
		if previous == nil && req.Version != 0 || previous != nil && uint64(previous.Version) != req.Version {
			return ErrChanged
		}
		secret := ""
		if previous != nil && len(previous.ClientSecretBox) > 0 {
			plain, err := s.Keys.Open(secretBinding(*previous), previous.ClientSecretBox)
			if err != nil {
				return err
			}
			secret = string(plain)
		}
		if req.ClientSecret != nil {
			secret = *req.ClientSecret
		}
		updating := previous != nil && previous.Issuer == candidate.Issuer && previous.ClientID == candidate.ClientID && previous.Provider == candidate.Provider && previous.TenantID == candidate.TenantID
		if updating {
			st, err := s.state(ctx, q, p, ws)
			if err != nil {
				return err
			}
			if st.Policy.Mode == identitypolicy.Enforced && !st.RecoveryReady {
				return ErrDenied
			}
			candidate.ID = previous.ID
			candidate.Version = previous.Version + 1
		} else {
			candidate.ID, err = q.ReserveIdentityID(ctx)
			if err != nil {
				return err
			}
		}
		var box []byte
		if secret != "" {
			box, err = s.Keys.Seal(secretBinding(candidate), []byte(secret))
			if err != nil {
				return err
			}
		}
		var saved sqlc.WorkspaceIdentityConnection
		if updating {
			saved, err = q.UpdateIdentityConnection(ctx, sqlc.UpdateIdentityConnectionParams{WorkspaceID: ws, ID: candidate.ID, ExpectedVersion: previous.Version, Name: candidate.Name, ClientID: candidate.ClientID, Scopes: candidate.Scopes, ClientSecretBox: box})
		} else {
			saved, err = q.CreateIdentityConnection(ctx, sqlc.CreateIdentityConnectionParams{ID: &candidate.ID, WorkspaceID: ws, Name: candidate.Name, Provider: candidate.Provider, Issuer: candidate.Issuer, TenantID: candidate.TenantID, ClientID: candidate.ClientID, Status: "draft", Scopes: candidate.Scopes, ClientSecretBox: box, CreatedBy: &p.UserID})
		}
		if err != nil {
			return err
		}
		if updating {
			if err = Invalidate(ctx, q, ws, nil, "connection_changed"); err != nil {
				return err
			}
		}
		if err = Audit(ctx, q, ws, &p.UserID, "connection_changed", &saved.ID); err != nil {
			return err
		}
		out = ConnectionView(saved)
		return nil
	})
	return out, err
}

// ActivateConnection selects only a successfully tested current revision.
func (s *Service) ActivateConnection(ctx context.Context, p identitypolicy.Principal, ws, connection uuid.UUID, version int64) (*pb.IdentityConnection, error) {
	var out *pb.IdentityConnection
	err := s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
			return err
		}
		st, err := s.state(ctx, q, p, ws)
		if err != nil {
			return err
		}
		if !ownerTestAllowed(s.now(), st) {
			return ErrDenied
		}
		c, err := q.GetIdentityConnectionForUpdate(ctx, sqlc.GetIdentityConnectionForUpdateParams{WorkspaceID: ws, ID: connection})
		if err != nil || c.Version != version || c.TestedVersion == nil || *c.TestedVersion != version || c.TestedAt == nil || !s.now().Before(c.TestedAt.Add(5*time.Minute)) {
			return ErrChanged
		}
		evidence, err := q.GetRecentIdentityConnectionTest(ctx, sqlc.GetRecentIdentityConnectionTestParams{WorkspaceID: ws, ConnectionID: connection, UserID: &p.UserID, ConnectionVersion: version})
		if err != nil {
			return ErrDenied
		}
		var proof completion
		if s.open(evidence, "sso-completion", evidence.ResultBox, &proof) != nil || proof.UserID != p.UserID {
			return ErrDenied
		}
		identity, err := q.GetExternalIdentity(ctx, sqlc.GetExternalIdentityParams{WorkspaceID: ws, ID: proof.IdentityID})
		if err != nil || identity.UserID != p.UserID || identity.ConnectionID != connection || identity.Version != proof.Versions.Identity || identity.Status != "active" {
			return ErrDenied
		}
		all, err := q.ListIdentityConnections(ctx, ws)
		if err != nil {
			return err
		}
		for _, old := range all {
			if old.Status == "active" && old.ID != c.ID {
				if _, err = q.DisableIdentityConnection(ctx, sqlc.DisableIdentityConnectionParams{WorkspaceID: ws, ID: old.ID}); err != nil {
					return err
				}
			}
		}
		c, err = q.ActivateIdentityConnection(ctx, sqlc.ActivateIdentityConnectionParams{WorkspaceID: ws, ID: connection, Version: version})
		if err != nil {
			return err
		}
		if err = Invalidate(ctx, q, ws, nil, "connection_activated"); err != nil {
			return err
		}
		if err = Audit(ctx, q, ws, &p.UserID, "connection_activated", &c.ID); err != nil {
			return err
		}
		out = ConnectionView(c)
		return nil
	})
	return out, err
}

func mode(v pb.IdentityPolicyMode) identitypolicy.Mode {
	switch v {
	case pb.IdentityPolicyMode_IDENTITY_POLICY_MODE_OFF:
		return identitypolicy.Off
	case pb.IdentityPolicyMode_IDENTITY_POLICY_MODE_OPTIONAL:
		return identitypolicy.Optional
	case pb.IdentityPolicyMode_IDENTITY_POLICY_MODE_ENFORCED:
		return identitypolicy.Enforced
	}
	return ""
}

// SetPolicy preserves enforcement on dependency failure and requires owner recovery or both proofs.
func (s *Service) SetPolicy(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID, req *pb.PutIdentityPolicyRequest) error {
	if req == nil || mode(req.Mode) == "" {
		return ErrInvalid
	}
	return s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
			return err
		}
		if _, err := q.EnsureIdentityPolicy(ctx, ws); err != nil {
			return err
		}
		st, err := s.state(ctx, q, p, ws)
		if err != nil {
			return err
		}
		if uint64(st.Policy.Version) != req.Version {
			return ErrChanged
		}
		desired := mode(req.Mode)
		if p.Authority == identitypolicy.Recovery {
			if desired == identitypolicy.Enforced || !identitypolicy.Evaluate(s.now(), st, identitypolicy.RepairPolicy).Allowed {
				return ErrDenied
			}
		} else {
			if !identitypolicy.Evaluate(s.now(), st, identitypolicy.ManageSSO).Allowed {
				return ErrDenied
			}
			if desired == identitypolicy.Enforced && !identitypolicy.EvaluateEnforcement(s.now(), st).Allowed {
				return ErrDenied
			}
		}
		if _, err = q.SetIdentityPolicy(ctx, sqlc.SetIdentityPolicyParams{WorkspaceID: ws, ExpectedVersion: st.Policy.Version, Mode: string(desired), AssuranceMaxAgeSeconds: int32(st.Policy.MaxAge / time.Second), UpdatedBy: &p.UserID}); err != nil {
			return err
		}
		if err = Invalidate(ctx, q, ws, nil, "policy_changed"); err != nil {
			return err
		}
		return Audit(ctx, q, ws, &p.UserID, "policy_changed", nil)
	})
}
func (s *Service) freshOwner(ctx context.Context, q *sqlc.Queries, p identitypolicy.Principal, ws uuid.UUID) (identitypolicy.State, error) {
	st, err := s.manage(ctx, q, p, ws)
	if err != nil {
		return st, err
	}
	if st.Policy.Mode == identitypolicy.Enforced {
		fresh := st
		fresh.Policy.MaxAge = 5 * time.Minute
		if !identitypolicy.Evaluate(s.now(), fresh, identitypolicy.ManageSSO).Allowed {
			return st, ErrDenied
		}
	}
	return st, nil
}

// RecoveryKit rotates ten one-time hashes after independently proven local ownership.
func (s *Service) RecoveryKit(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID) (*pb.IdentityRecoveryKitResponse, error) {
	out := &pb.IdentityRecoveryKitResponse{}
	err := s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		st, err := s.freshOwner(ctx, q, p, ws)
		if err != nil {
			return err
		}
		// Setup while off/optional is the recovery bootstrap; enforced still requires SSO.
		if st.Principal.Authority != identitypolicy.LocalAccount || st.BuiltinRole != "owner" {
			return ErrDenied
		}
		if _, err = q.DeleteIdentityRecoveryCodes(ctx, ws); err != nil {
			return err
		}
		for range 10 {
			code, err := identitycrypto.Secret()
			if err != nil {
				return err
			}
			if _, err = q.CreateIdentityRecoveryCode(ctx, sqlc.CreateIdentityRecoveryCodeParams{WorkspaceID: ws, OwnerID: p.UserID, CodeHash: identitycrypto.Hash(code), ExpiresAt: s.now().AddDate(1, 0, 0)}); err != nil {
				return err
			}
			out.CodesOnce = append(out.CodesOnce, code)
		}
		return Audit(ctx, q, ws, &p.UserID, "recovery_kit_rotated", nil)
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Recover cannot read workspace data, mint SSO assurance or issue OAuth grants.
func (s *Service) Recover(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID, code string) (*pb.AuthTokens, error) {
	var tokens *pb.AuthTokens
	err := s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
			return err
		}
		st, err := s.state(ctx, q, p, ws)
		if err != nil {
			return err
		}
		if st.Principal.Authority != identitypolicy.LocalAccount || !identitypolicy.Evaluate(s.now(), st, identitypolicy.RepairPolicy).Allowed {
			return ErrDenied
		}
		if _, err = q.ConsumeIdentityRecoveryCode(ctx, sqlc.ConsumeIdentityRecoveryCodeParams{WorkspaceID: ws, OwnerID: p.UserID, CodeHash: identitycrypto.Hash(code)}); err != nil {
			return ErrDenied
		}
		issued, err := s.issue(ctx, q, IssueRequest{UserID: p.UserID, WorkspaceID: ws, Authority: identitypolicy.Recovery, AuthenticatedAt: s.now(), ExpiresAt: s.now().Add(10 * time.Minute)})
		if err != nil {
			return err
		}
		tokens = issued.Tokens
		return Audit(ctx, q, ws, &p.UserID, "recovery_session_issued", &issued.Principal.SessionID)
	})
	return tokens, err
}

// Unlink requires both independent local authentication and fresh corporate proof.
func (s *Service) Unlink(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID) error {
	return s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
			return err
		}
		st, err := s.state(ctx, q, p, ws)
		if err != nil {
			return err
		}
		if !identitypolicy.CheckGlobal(s.now(), st.Principal, identitypolicy.LinkIdentity, false).Allowed {
			return ErrDenied
		}
		fresh := st
		fresh.Policy.Mode = identitypolicy.Enforced
		fresh.Policy.MaxAge = 5 * time.Minute
		if !identitypolicy.Evaluate(s.now(), fresh, identitypolicy.WorkspaceRead).Allowed {
			return ErrDenied
		}
		if st.BuiltinRole == "owner" && (st.Policy.Mode == identitypolicy.Enforced || !st.RecoveryReady) {
			return ErrDenied
		}
		c, err := q.GetActiveIdentityConnection(ctx, ws)
		if err != nil {
			return err
		}
		identity, err := q.FindUserExternalIdentity(ctx, sqlc.FindUserExternalIdentityParams{WorkspaceID: ws, ConnectionID: c.ID, UserID: p.UserID})
		if err != nil {
			return ErrNotLinked
		}
		if _, err = q.SetExternalIdentityStatus(ctx, sqlc.SetExternalIdentityStatusParams{WorkspaceID: ws, ID: identity.ID, Status: "unlinked"}); err != nil {
			return err
		}
		if err = Invalidate(ctx, q, ws, &p.UserID, "identity_unlinked"); err != nil {
			return err
		}
		return Audit(ctx, q, ws, &p.UserID, "identity_unlinked", &identity.ID)
	})
}

// Status exposes only the caller's proof; owner config is always redacted.
func (s *Service) Status(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID) (*pb.GetWorkspaceIdentityResponse, error) {
	st, err := s.loader(s.DB.Q).LoadIdentityState(ctx, p.SessionID, p.UserID, ws)
	if err != nil {
		return nil, err
	}
	if !identitypolicy.CheckSession(s.now(), st.Principal).Allowed || !st.Member || st.Principal.Authority != identitypolicy.LocalAccount && st.Principal.WorkspaceID != ws {
		return nil, ErrDenied
	}
	modes := map[identitypolicy.Mode]pb.IdentityPolicyMode{identitypolicy.Off: pb.IdentityPolicyMode_IDENTITY_POLICY_MODE_OFF, identitypolicy.Optional: pb.IdentityPolicyMode_IDENTITY_POLICY_MODE_OPTIONAL, identitypolicy.Enforced: pb.IdentityPolicyMode_IDENTITY_POLICY_MODE_ENFORCED}
	out := &pb.GetWorkspaceIdentityResponse{Access: &pb.WorkspaceIdentityAccess{WorkspaceId: ws.String(), Mode: modes[st.Policy.Mode], PolicyVersion: uint64(st.Policy.Version), MembershipVersion: uint64(st.AccessVersion)}}
	if st.Assurance != nil && !st.Assurance.Revoked {
		out.Access.Assurance = &pb.WorkspaceAssurance{WorkspaceId: ws.String(), AuthenticatedAt: timestamppb.New(st.Assurance.AuthenticatedAt), ExpiresAt: timestamppb.New(st.Assurance.ValidUntil), PolicyVersion: uint64(st.Assurance.Versions.Policy), ConnectionVersion: uint64(st.Assurance.Versions.Connection)}
	}
	if st.BuiltinRole == "owner" && st.Principal.Authority == identitypolicy.LocalAccount {
		all, err := s.DB.Q.ListIdentityConnections(ctx, ws)
		if err != nil {
			return nil, err
		}
		if len(all) > 0 {
			out.Connection = ConnectionView(all[len(all)-1])
		}
	}
	return out, nil
}
