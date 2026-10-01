// Package identitypolicy evaluates session authority before existing resource permissions.
// A successful decision never substitutes for computePermissions or a resource scope lookup.
package identitypolicy

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

type Authority string

const (
	LocalAccount Authority = "local_account"
	WorkspaceSSO Authority = "workspace_sso"
	Recovery     Authority = "recovery"
)

type Mode string

const (
	Off      Mode = "off"
	Optional Mode = "optional"
	Enforced Mode = "enforced"
)

type Operation string

const (
	WorkspaceRead   Operation = "read"
	WorkspaceWrite  Operation = "mutate"
	Realtime        Operation = "realtime"
	RTC             Operation = "rtc"
	ManageDirectory Operation = "manage_directory"
	BootstrapLink   Operation = "bootstrap_link"
	ManageSSO       Operation = "manage_sso"
	ManageOAuth     Operation = "manage_oauth"
	OAuthAuthorize  Operation = "oauth_authorize"
	OAuthExchange   Operation = "oauth_exchange"
	OAuthRefresh    Operation = "oauth_refresh"
	OAuthUserInfo   Operation = "oauth_userinfo"
	RepairPolicy    Operation = "recover_policy"
	GlobalRead      Operation = "global_read"
	GlobalWrite     Operation = "global_write"
	LinkIdentity    Operation = "link_identity"
	ProductAdmin    Operation = "product_admin"
)

type Feature string

const (
	SSO           Feature = "corporate_sso"
	DirectorySync Feature = "directory_sync"
	OAuthProvider Feature = "oauth_provider"
)
const (
	CorporateProofMaxAge  = time.Hour
	RecoveryMaxAge        = 10 * time.Minute
	ManagementMaxAge      = 5 * time.Minute
	AccessTokenTTL        = 5 * time.Minute
	AuthorizationCodeTTL  = time.Minute
	RefreshAbsoluteTTL    = 8 * time.Hour
	RefreshIdleTTL        = 30 * time.Minute
	ReadLeaseTTL          = 30 * time.Second
	DirectorySyncInterval = 5 * time.Minute
	DirectoryMaxStaleness = time.Hour
)

type Principal struct {
	UserID, SessionID                                        uuid.UUID
	Authority                                                Authority
	WorkspaceID, ConnectionID                                uuid.UUID
	LocalAuthenticatedAt, RecoveryAuthenticatedAt, ExpiresAt time.Time
	Revoked                                                  bool
	Guest, Bot                                               bool
	Version                                                  int64
}
type Versions struct {
	Policy, Access, Connection, Identity, Entitlement, Session int64
}
type Grant struct {
	WorkspaceID                    uuid.UUID
	Feature                        Feature
	Source                         string
	Enabled, PlanEligible, Revoked bool
	ValidUntil                     time.Time // zero only for a perpetual grant; never an access lease
	Version                        int64
}

// EntitlementConfig is trusted operator configuration, never request input.
type EntitlementConfig struct {
	Edition                string
	EnterpriseWorkspaceIDs map[uuid.UUID]bool
}

func (c EntitlementConfig) Eligible(ws uuid.UUID, source string, business bool) bool {
	switch source {
	case "cloud_business":
		return c.Edition == "cloud" && business
	case "onprem_enterprise":
		return c.Edition == "enterprise" && c.EnterpriseWorkspaceIDs[ws]
	default:
		return false
	}
}

type Policy struct {
	Mode    Mode
	Version int64
	MaxAge  time.Duration
}
type Assurance struct {
	WorkspaceID, UserID, SessionID, ConnectionID, IdentityID uuid.UUID
	AuthenticatedAt, ValidUntil                              time.Time
	Versions                                                 Versions
	Revoked                                                  bool
}
type Connection struct {
	ID              uuid.UUID
	Version         int64
	Enabled, Tested bool
}
type Identity struct {
	ID, ConnectionID uuid.UUID
	Version          int64
	Active           bool
}
type Directory struct {
	Required, Active, Enabled bool
	ValidUntil                time.Time
}

// State is a coherent database snapshot. Membership is checked independently of tombstones.
type State struct {
	Principal                                    Principal
	WorkspaceID                                  uuid.UUID
	Member                                       bool
	BuiltinRole                                  string
	Suspended, WorkspaceSuspended, RecoveryReady bool
	AccessVersion                                int64
	Policy                                       Policy
	Grants                                       map[Feature]Grant
	EntitlementVersion                           int64
	Assurance                                    *Assurance
	Connection                                   Connection
	Identity                                     Identity
	Directory                                    Directory
	ProductAdminGranted                          bool
}
type Reason string

const (
	Allowed             Reason = "allowed"
	InvalidSession      Reason = "invalid_session"
	ScopeDenied         Reason = "authority_scope_denied"
	MembershipRequired  Reason = "membership_required"
	MembershipSuspended Reason = "membership_suspended"
	PolicyInvalid       Reason = "identity_policy_invalid"
	EntitlementRequired Reason = "identity_entitlement_required"
	SSORequired         Reason = "sso_required"
	WorkspaceSuspended  Reason = "workspace_suspended"
	DirectoryStale      Reason = "directory_stale"
	RoleRequired        Reason = "builtin_role_required"
	RecentAuthRequired  Reason = "recent_auth_required"
	UnknownOperation    Reason = "unknown_operation"
	StateUnavailable    Reason = "identity_state_unavailable"
)

type Decision struct {
	Allowed    bool
	Reason     Reason
	ValidUntil time.Time
	Versions   Versions
}

func deny(r Reason) Decision { return Decision{Reason: r} }
func minimum(a, b time.Time) time.Time {
	if a.IsZero() || b.Before(a) {
		return b
	}
	return a
}
func recent(now, at time.Time, maxAge time.Duration) bool {
	return !at.IsZero() && !at.After(now) && now.Before(at.Add(maxAge))
}

// CheckSession rejects missing/unknown authority. Refresh must preserve these fields.
func CheckSession(now time.Time, p Principal) Decision {
	if p.UserID == uuid.Nil || p.SessionID == uuid.Nil || p.Revoked || p.Version < 1 || !now.Before(p.ExpiresAt) {
		return deny(InvalidSession)
	}
	switch p.Authority {
	case LocalAccount:
		if p.WorkspaceID != uuid.Nil || p.ConnectionID != uuid.Nil {
			return deny(InvalidSession)
		}
	case WorkspaceSSO:
		if p.WorkspaceID == uuid.Nil || p.ConnectionID == uuid.Nil || !p.LocalAuthenticatedAt.IsZero() {
			return deny(InvalidSession)
		}
	case Recovery:
		if p.WorkspaceID == uuid.Nil || p.ConnectionID != uuid.Nil || !p.LocalAuthenticatedAt.IsZero() {
			return deny(InvalidSession)
		}
	default:
		return deny(InvalidSession)
	}
	return Decision{Allowed: true, Reason: Allowed, ValidUntil: p.ExpiresAt, Versions: Versions{Session: p.Version}}
}

// RequireEntitlement is independent of permissive legacy plans.Limits feature flags.
func RequireEntitlement(now time.Time, workspaceID uuid.UUID, g Grant, f Feature) Decision {
	if workspaceID == uuid.Nil || g.WorkspaceID != workspaceID || g.Feature != f || !g.Enabled || g.Revoked || g.Version < 1 || (!g.ValidUntil.IsZero() && !now.Before(g.ValidUntil)) || !g.PlanEligible {
		return deny(EntitlementRequired)
	}
	if g.Source != "cloud_business" && g.Source != "onprem_enterprise" {
		return deny(EntitlementRequired)
	}
	switch f {
	case SSO, DirectorySync, OAuthProvider:
	default:
		return deny(EntitlementRequired)
	}
	until := now.Add(RefreshAbsoluteTTL)
	if !g.ValidUntil.IsZero() {
		until = minimum(until, g.ValidUntil)
	}
	return Decision{Allowed: true, Reason: Allowed, ValidUntil: until, Versions: Versions{Entitlement: g.Version}}
}

// CheckGlobal requires independently authenticated account authority. ProductAdmin also
// needs an operator grant; upstream email claims are never considered here.
func CheckGlobal(now time.Time, p Principal, op Operation, productAdminGranted bool) Decision {
	d := CheckSession(now, p)
	if !d.Allowed {
		return d
	}
	if p.Authority != LocalAccount {
		return deny(ScopeDenied)
	}
	switch op {
	case GlobalRead, GlobalWrite:
	case LinkIdentity, ProductAdmin:
		if op == ProductAdmin && !productAdminGranted {
			return deny(RoleRequired)
		}
		if !recent(now, p.LocalAuthenticatedAt, ManagementMaxAge) {
			return deny(RecentAuthRequired)
		}
		d.ValidUntil = minimum(d.ValidUntil, p.LocalAuthenticatedAt.Add(ManagementMaxAge))
	default:
		return deny(UnknownOperation)
	}
	return d
}

// Evaluate rejects unknown values and never changes an enforced policy when a grant expires.
// Caller still checks existing permission bits after this gate.
func Evaluate(now time.Time, s State, op Operation) Decision {
	p := s.Principal
	d := CheckSession(now, p)
	if !d.Allowed {
		return d
	}
	if s.WorkspaceID == uuid.Nil {
		return deny(ScopeDenied)
	}
	if p.Authority != LocalAccount && p.WorkspaceID != s.WorkspaceID {
		return deny(ScopeDenied)
	}
	if p.Authority == Recovery && op != RepairPolicy {
		return deny(ScopeDenied)
	}
	if s.WorkspaceSuspended {
		return deny(WorkspaceSuspended)
	}
	if !s.Member {
		return deny(MembershipRequired)
	}
	if s.Suspended {
		return deny(MembershipSuspended)
	}
	if p.Bot {
		return deny(ScopeDenied)
	}
	if s.AccessVersion < 1 || s.Policy.Version < 1 || (s.Policy.Mode != Off && s.Policy.Mode != Optional && s.Policy.Mode != Enforced) || s.Policy.MaxAge < ManagementMaxAge || s.Policy.MaxAge > CorporateProofMaxAge {
		return deny(PolicyInvalid)
	}
	d.Versions = Versions{Policy: s.Policy.Version, Access: s.AccessVersion, Connection: s.Connection.Version, Identity: s.Identity.Version, Entitlement: s.EntitlementVersion, Session: p.Version}
	if op == RepairPolicy {
		if s.BuiltinRole != "owner" {
			return deny(RoleRequired)
		}
		at := p.LocalAuthenticatedAt
		maxAge := ManagementMaxAge
		if p.Authority == Recovery {
			at = p.RecoveryAuthenticatedAt
			maxAge = RecoveryMaxAge
		}
		if p.Authority == WorkspaceSSO || !recent(now, at, maxAge) {
			return deny(RecentAuthRequired)
		}
		d.ValidUntil = minimum(d.ValidUntil, at.Add(maxAge))
		return d
	}
	feature := Feature("")
	switch op {
	case WorkspaceRead, WorkspaceWrite, Realtime, RTC:
	case ManageDirectory:
		if s.BuiltinRole != "owner" {
			return deny(RoleRequired)
		}
		feature = DirectorySync
	case BootstrapLink:
		if p.Guest {
			return deny(ScopeDenied)
		}
		feature = SSO
	case ManageSSO:
		if s.BuiltinRole != "owner" {
			return deny(RoleRequired)
		}
		feature = SSO
	case ManageOAuth:
		if s.BuiltinRole != "owner" && s.BuiltinRole != "admin" {
			return deny(RoleRequired)
		}
		feature = OAuthProvider
	case OAuthAuthorize, OAuthExchange, OAuthRefresh, OAuthUserInfo:
		feature = OAuthProvider
	default:
		return deny(UnknownOperation)
	}
	if p.Guest && feature != "" {
		return deny(ScopeDenied)
	}
	if op == ManageSSO || op == ManageOAuth || op == ManageDirectory || op == BootstrapLink {
		if p.Authority != LocalAccount || !recent(now, p.LocalAuthenticatedAt, ManagementMaxAge) {
			return deny(RecentAuthRequired)
		}
		d.ValidUntil = minimum(d.ValidUntil, p.LocalAuthenticatedAt.Add(ManagementMaxAge))
	}
	if feature != "" {
		e := RequireEntitlement(now, s.WorkspaceID, s.Grants[feature], feature)
		if !e.Allowed {
			return e
		}
		d.ValidUntil = minimum(d.ValidUntil, e.ValidUntil)
	}
	needProof := (s.Policy.Mode == Enforced && op != BootstrapLink) || p.Authority == WorkspaceSSO
	if needProof {
		e := RequireEntitlement(now, s.WorkspaceID, s.Grants[SSO], SSO)
		if !e.Allowed {
			return e
		}
		d.ValidUntil = minimum(d.ValidUntil, e.ValidUntil)
		proofAge := s.Policy.MaxAge
		if op == ManageSSO || op == ManageOAuth || op == ManageDirectory {
			proofAge = ManagementMaxAge
		}
		a := s.Assurance
		if s.BuiltinRole == "guest" || a == nil || a.Revoked || !s.Connection.Enabled || !s.Connection.Tested || !s.Identity.Active || s.Identity.ConnectionID != s.Connection.ID || a.IdentityID != s.Identity.ID || a.ConnectionID != s.Connection.ID || (p.Authority == WorkspaceSSO && p.ConnectionID != a.ConnectionID) || a.WorkspaceID != s.WorkspaceID || a.UserID != p.UserID || a.SessionID != p.SessionID || a.AuthenticatedAt.After(now) || !now.Before(a.ValidUntil) || !recent(now, a.AuthenticatedAt, proofAge) || a.ValidUntil.After(a.AuthenticatedAt.Add(CorporateProofMaxAge)) || a.Versions.Policy != s.Policy.Version || a.Versions.Access != s.AccessVersion || a.Versions.Connection != s.Connection.Version || a.Versions.Identity != s.Identity.Version || a.Versions.Entitlement != s.EntitlementVersion || a.Versions.Session != p.Version {
			return deny(SSORequired)
		}
		d.ValidUntil = minimum(d.ValidUntil, minimum(a.ValidUntil, a.AuthenticatedAt.Add(proofAge)))
	}
	if s.Directory.Required && op != BootstrapLink {
		e := RequireEntitlement(now, s.WorkspaceID, s.Grants[DirectorySync], DirectorySync)
		if !e.Allowed {
			return e
		}
		d.ValidUntil = minimum(d.ValidUntil, e.ValidUntil)
		dir := s.Directory
		if !dir.Active || !dir.Enabled || !now.Before(dir.ValidUntil) {
			return deny(DirectoryStale)
		}
		d.ValidUntil = minimum(d.ValidUntil, dir.ValidUntil)
	}
	return d
}

// EvaluateEnforcement checks the proofs and recovery kit needed before enabling enforced.
func EvaluateEnforcement(now time.Time, s State) Decision {
	if !s.RecoveryReady {
		return deny(RecentAuthRequired)
	}
	s.Policy.Mode = Enforced
	return Evaluate(now, s, ManageSSO)
}

// Loader must return a fresh coherent snapshot, including session revocation and all versions.
// Use a transaction-bound sqlc.Queries for code exchange, refresh, and sensitive mutations.
type Loader interface {
	LoadIdentityState(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (State, error)
}
type Service struct {
	Loader Loader
	Now    func() time.Time
}

var ErrDenied = errors.New("identity policy denied")

func (s *Service) CheckWorkspace(ctx context.Context, p Principal, ws uuid.UUID, op Operation) (Decision, error) {
	if s == nil || s.Loader == nil {
		return deny(StateUnavailable), ErrDenied
	}
	state, err := s.Loader.LoadIdentityState(ctx, p.SessionID, p.UserID, ws)
	if err != nil {
		return deny(StateUnavailable), err
	}
	if state.Principal.SessionID != p.SessionID || state.Principal.UserID != p.UserID || state.WorkspaceID != ws {
		return deny(StateUnavailable), ErrDenied
	}
	now := time.Now()
	if s.Now != nil {
		now = s.Now()
	}
	d := Evaluate(now, state, op)
	if !d.Allowed {
		return d, ErrDenied
	}
	return d, nil
}

// Lease caps cached read/fan-out decisions; mutations must use a fresh database check.
func (d Decision) Lease(now time.Time) time.Time {
	if !d.Allowed {
		return time.Time{}
	}
	return minimum(d.ValidUntil, now.Add(ReadLeaseTTL))
}
