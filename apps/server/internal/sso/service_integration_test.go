//go:build integration

package sso

import (
	"context"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
)

type fixtureIssuer struct{}

func (fixtureIssuer) IssueIdentityTokens(_ context.Context, _ *sqlc.Queries, row sqlc.Session, refresh string) (*pb.AuthTokens, error) {
	return &pb.AuthTokens{SessionId: row.ID.String(), RefreshToken: refresh}, nil
}

type serviceFixture struct {
	s          *Service
	idp        *fakeIDP
	ws, user   uuid.UUID
	p          identitypolicy.Principal
	connection uuid.UUID
}

func newServiceFixture(t *testing.T) *serviceFixture {
	t.Helper()
	ctx := context.Background()
	dsn := os.Getenv("TEST_PG_URL")
	if dsn == "" {
		t.Fatal("TEST_PG_URL required")
	}
	d, err := db.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	if err = d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	keys, err := identitycrypto.New("fixture", map[string][]byte{"fixture": make([]byte, 32)})
	if err != nil {
		t.Fatal(err)
	}
	f, protocol, _ := newIDP(t)
	user, ws, session := uuid.New(), uuid.New(), uuid.New()
	now := time.Now()
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	fixtures := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,display_name,password_hash)VALUES($1,$2,'Owner','fixture')`, []any{user, user.String() + "@sso.test"}},
		{`INSERT INTO workspaces(id,slug,name,owner_id)VALUES($1,$2,'SSO Fixture',$3)`, []any{ws, "sso-" + ws.String()[:12], user}},
		{`INSERT INTO workspace_members(workspace_id,user_id,role)VALUES($1,$2,'owner')`, []any{ws, user}},
		{`INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at,local_authenticated_at)VALUES($1,$2,$3,$4,$5)`, []any{session, user, identitycrypto.Hash("fixture"), now.Add(time.Hour), now}},
		{`INSERT INTO workspace_plans(workspace_id,plan)VALUES($1,'enterprise') ON CONFLICT(workspace_id) DO UPDATE SET plan='enterprise'`, []any{ws}},
	}
	for _, v := range fixtures {
		if _, err = tx.Exec(ctx, v.sql, v.args...); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
	}
	q := d.Q.WithTx(tx)
	if _, err = q.UpsertIdentityGrant(ctx, sqlc.UpsertIdentityGrantParams{WorkspaceID: ws, Feature: "corporate_sso", Source: "cloud_business", Enabled: true}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = d.Pool.Exec(ctx, `DELETE FROM workspaces WHERE id=$1`, ws)
		_, _ = d.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, user)
		d.Close()
	})
	s := &Service{DB: d, Keys: keys, Protocol: protocol, Edition: identitypolicy.EntitlementConfig{Edition: "cloud"}, Sessions: fixtureIssuer{}}
	p := identitypolicy.Principal{SessionID: session, UserID: user, Authority: identitypolicy.LocalAccount, LocalAuthenticatedAt: now, ExpiresAt: now.Add(time.Hour), Version: 1}
	secret := "fixture-secret"
	view, err := s.PutConnection(ctx, p, ws, &pb.PutIdentityConnectionRequest{Name: "Fixture", Provider: pb.IdentityProvider_IDENTITY_PROVIDER_GENERIC, Issuer: f.server.URL, ClientId: "fixture-client", ClientSecret: &secret})
	if err != nil {
		t.Fatal(err)
	}
	connection, _ := uuid.Parse(view.Id)
	return &serviceFixture{s: s, idp: f, ws: ws, user: user, p: p, connection: connection}
}
func (f *serviceFixture) web(t *testing.T, purpose pb.SSOFlowPurpose, subject string) (BeginResult, CallbackResult) {
	t.Helper()
	begin, err := f.s.Begin(context.Background(), f.p, f.ws, &pb.SSOBeginRequest{Purpose: purpose, ClientKind: pb.SSOClientKind_SSO_CLIENT_KIND_WEB})
	if err != nil {
		t.Fatal(err)
	}
	code, state := f.idp.code(t, begin.Response.AuthorizationUrl, subject, nil)
	callback, err := f.s.Callback(context.Background(), f.connection, state, begin.Browser, code)
	if err != nil {
		t.Fatal(err)
	}
	return begin, callback
}
func (f *serviceFixture) activate(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	begin, callback := f.web(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LINK, "owner-subject")
	if _, err := f.s.Finish(ctx, callback.FlowID, begin.Browser); err != nil {
		t.Fatal(err)
	}
	begin, callback = f.web(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_TEST, "owner-subject")
	if result, err := f.s.Finish(ctx, callback.FlowID, begin.Browser); err != nil || !result.Tested || result.Tokens != nil || result.Assurance != nil {
		t.Fatalf("test grants data: %v %+v", err, result)
	}
	if _, err := f.s.ActivateConnection(ctx, f.p, f.ws, f.connection, 1); err != nil {
		t.Fatal(err)
	}
}
func TestSSOWebNativeAtomicAndEpochs(t *testing.T) {
	f := newServiceFixture(t)
	f.activate(t)
	ctx := context.Background()
	begin, callback := f.web(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LOGIN, "owner-subject")
	var winners atomic.Int32
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			out, err := f.s.Finish(ctx, callback.FlowID, begin.Browser)
			if err == nil {
				if out.Tokens == nil || out.Assurance == nil {
					t.Error("missing scoped result")
				}
				winners.Add(1)
			}
		})
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatalf("finish winners %d", winners.Load())
	}
	verifier, _ := identitycrypto.Secret()
	challenge, _ := identitycrypto.S256(verifier)
	native, err := f.s.Begin(ctx, identitypolicy.Principal{}, f.ws, &pb.SSOBeginRequest{Purpose: pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LOGIN, ClientKind: pb.SSOClientKind_SSO_CLIENT_KIND_DESKTOP, DesktopChallenge: challenge})
	if err != nil {
		t.Fatal(err)
	}
	start := mustURL(native.Response.BrowserStartUrl).Query().Get("handle")
	flow, browser, auth, err := f.s.BrowserStart(ctx, start)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err = f.s.BrowserStart(ctx, start); err == nil {
		t.Fatal("bootstrap replay accepted")
	}
	code, state := f.idp.code(t, auth, "owner-subject", nil)
	cb, err := f.s.Callback(ctx, f.connection, state, browser, code)
	if err != nil || !cb.Native {
		t.Fatal(err)
	}
	other, _ := identitycrypto.Secret()
	if _, err = f.s.Exchange(ctx, flow, cb.Ticket, other); err == nil {
		t.Fatal("intercepted scheme exchanged")
	}
	result, err := f.s.Exchange(ctx, flow, cb.Ticket, verifier)
	if err != nil || result.Tokens == nil {
		t.Fatalf("native exchange %v", err)
	}
	row, err := f.s.DB.Q.GetSession(ctx, mustUUID(t, result.Tokens.SessionId))
	if err != nil || row.AuthorityKind != "workspace_sso" || row.AuthorityWorkspaceID == nil || *row.AuthorityWorkspaceID != f.ws || row.LocalAuthenticatedAt != nil {
		t.Fatal("scope widened")
	}
	if _, err = f.s.Exchange(ctx, flow, cb.Ticket, verifier); err == nil {
		t.Fatal("native replay accepted")
	}
	begin, callback = f.web(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LOGIN, "owner-subject")
	if err = f.s.DB.Tx(ctx, func(q *sqlc.Queries) error { return Invalidate(ctx, q, f.ws, &f.user, "fixture_ban") }); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Finish(ctx, callback.FlowID, begin.Browser); !errors.Is(err, ErrChanged) {
		t.Fatalf("late epoch accepted %v", err)
	}
}
func mustUUID(t *testing.T, raw string) uuid.UUID {
	t.Helper()
	id, err := uuid.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
func TestSSOExplicitLinkNoEmailMerge(t *testing.T) {
	f := newServiceFixture(t)
	f.activate(t)
	ctx := context.Background()
	begin, err := f.s.Begin(ctx, identitypolicy.Principal{}, f.ws, &pb.SSOBeginRequest{Purpose: pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LOGIN, ClientKind: pb.SSOClientKind_SSO_CLIENT_KIND_WEB})
	if err != nil {
		t.Fatal(err)
	}
	code, state := f.idp.code(t, begin.Response.AuthorizationUrl, "unknown-subject", map[string]any{"email": f.user.String() + "@sso.test", "email_verified": true})
	if _, err = f.s.Callback(ctx, f.connection, state, begin.Browser, code); !errors.Is(err, ErrNotLinked) {
		t.Fatalf("email auto-link: %v", err)
	}
	var identities int
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM workspace_external_identities WHERE workspace_id=$1`, f.ws).Scan(&identities); err != nil || identities != 1 {
		t.Fatal("identity auto-created")
	}
	stale := f.p
	stale.LocalAuthenticatedAt = time.Now().Add(-10 * time.Minute)
	if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE sessions SET local_authenticated_at=$2 WHERE id=$1`, stale.SessionID, stale.LocalAuthenticatedAt); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Begin(ctx, stale, f.ws, &pb.SSOBeginRequest{Purpose: pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LINK, ClientKind: pb.SSOClientKind_SSO_CLIENT_KIND_WEB}); err == nil {
		t.Fatal("link without local proof")
	}
}
func TestSSORotationTestActivateRecovery(t *testing.T) {
	f := newServiceFixture(t)
	f.activate(t)
	ctx := context.Background()
	begin, cb := f.web(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_STEP_UP, "owner-subject")
	if _, err := f.s.Finish(ctx, cb.FlowID, begin.Browser); err != nil {
		t.Fatal(err)
	}
	kit, err := f.s.RecoveryKit(ctx, f.p, f.ws)
	if err != nil || len(kit.CodesOnce) != 10 {
		t.Fatal(err)
	}
	policy, err := f.s.DB.Q.GetIdentityPolicy(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.SetPolicy(ctx, f.p, f.ws, &pb.PutIdentityPolicyRequest{Version: uint64(max(policy.Version, 0)), Mode: pb.IdentityPolicyMode_IDENTITY_POLICY_MODE_ENFORCED}); err != nil {
		t.Fatal(err)
	}
	begin, cb = f.web(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_STEP_UP, "owner-subject")
	if _, err = f.s.Finish(ctx, cb.FlowID, begin.Browser); err != nil {
		t.Fatal(err)
	}
	rotated := "rotated-fixture-secret"
	if _, err = f.s.PutConnection(ctx, f.p, f.ws, &pb.PutIdentityConnectionRequest{Version: 1, Name: "Fixture", Provider: pb.IdentityProvider_IDENTITY_PROVIDER_GENERIC, Issuer: f.idp.server.URL, ClientId: "fixture-client", ClientSecret: &rotated}); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Begin(ctx, identitypolicy.Principal{}, f.ws, &pb.SSOBeginRequest{Purpose: pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LOGIN, ClientKind: pb.SSOClientKind_SSO_CLIENT_KIND_WEB}); err == nil {
		t.Fatal("rotation opened login")
	}
	test, err := f.s.Begin(ctx, f.p, f.ws, &pb.SSOBeginRequest{Purpose: pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_TEST, ClientKind: pb.SSOClientKind_SSO_CLIENT_KIND_WEB})
	if err != nil {
		t.Fatal(err)
	}
	bad, state := f.idp.code(t, test.Response.AuthorizationUrl, "other-owner", nil)
	if _, err = f.s.Callback(ctx, f.connection, state, test.Browser, bad); err == nil {
		t.Fatal("wrong owner test accepted")
	}
	if _, err = f.s.ActivateConnection(ctx, f.p, f.ws, f.connection, 2); err == nil {
		t.Fatal("failed test activated")
	}
	begin, cb = f.web(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_TEST, "owner-subject")
	if _, err = f.s.Finish(ctx, cb.FlowID, begin.Browser); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.ActivateConnection(ctx, f.p, f.ws, f.connection, 2); err != nil {
		t.Fatal(err)
	}
	begin, cb = f.web(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LOGIN, "owner-subject")
	if out, err := f.s.Finish(ctx, cb.FlowID, begin.Browser); err != nil || out.Tokens == nil {
		t.Fatal(err)
	}
	tokens, err := f.s.Recover(ctx, f.p, f.ws, kit.CodesOnce[0])
	if err != nil {
		t.Fatal(err)
	}
	row, err := f.s.DB.Q.GetSession(ctx, mustUUID(t, tokens.SessionId))
	if err != nil || row.AuthorityKind != "recovery" || row.AuthorityConnectionID != nil {
		t.Fatal("recovery scope wrong")
	}
	st, err := f.s.loader(f.s.DB.Q).LoadIdentityState(ctx, row.ID, f.user, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	for _, op := range []identitypolicy.Operation{identitypolicy.WorkspaceRead, identitypolicy.OAuthAuthorize, identitypolicy.RTC} {
		if identitypolicy.Evaluate(time.Now(), st, op).Allowed {
			t.Fatal("recovery grants data")
		}
	}
	if _, err = f.s.Recover(ctx, f.p, f.ws, kit.CodesOnce[0]); err == nil {
		t.Fatal("recovery replay accepted")
	}
}

func TestSSONewIssuerNeverInheritsOldSecret(t *testing.T) {
	f := newServiceFixture(t)
	f.activate(t)
	other, _, _ := newIDP(t)
	_, err := f.s.PutConnection(context.Background(), f.p, f.ws, &pb.PutIdentityConnectionRequest{Version: 1, Name: "Replacement", Provider: pb.IdentityProvider_IDENTITY_PROVIDER_GENERIC, Issuer: other.server.URL, ClientId: "other-client"})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("omitted credential crossed issuer boundary: %v", err)
	}
	rows, err := f.s.DB.Q.ListIdentityConnections(context.Background(), f.ws)
	if err != nil || len(rows) != 1 {
		t.Fatal("replacement created without explicit secret")
	}
	other.mu.Lock()
	calls := other.tokenCalls + other.discoveryCalls
	other.mu.Unlock()
	if calls != 0 {
		t.Fatal("old secret sent to replacement issuer")
	}
}

func TestSSOExpiredRecoveryKitAndRotation(t *testing.T) {
	f := newServiceFixture(t)
	f.activate(t)
	ctx := context.Background()
	begin, cb := f.web(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_STEP_UP, "owner-subject")
	if _, err := f.s.Finish(ctx, cb.FlowID, begin.Browser); err != nil {
		t.Fatal(err)
	}
	kit, err := f.s.RecoveryKit(ctx, f.p, f.ws)
	if err != nil || kit.ExpiresAt == nil || time.Until(kit.ExpiresAt.AsTime()) > 365*24*time.Hour || time.Until(kit.ExpiresAt.AsTime()) < 365*24*time.Hour-time.Minute {
		t.Fatal("kit expiry not fixed365days")
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE workspace_identity_recovery_codes SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1`, f.ws); err != nil {
		t.Fatal(err)
	}
	policy, err := f.s.DB.Q.GetIdentityPolicy(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.SetPolicy(ctx, f.p, f.ws, &pb.PutIdentityPolicyRequest{Version: uint64(max(policy.Version, 0)), Mode: pb.IdentityPolicyMode_IDENTITY_POLICY_MODE_ENFORCED}); err == nil {
		t.Fatal("expired kit enabled enforcement")
	}
	if _, err = f.s.Recover(ctx, f.p, f.ws, kit.CodesOnce[0]); err == nil {
		t.Fatal("expired recovery code accepted")
	}
	replacement, err := f.s.RecoveryKit(ctx, f.p, f.ws)
	if err != nil || len(replacement.CodesOnce) != 10 {
		t.Fatal(err)
	}
	if _, err = f.s.Recover(ctx, f.p, f.ws, kit.CodesOnce[0]); err == nil {
		t.Fatal("rotated kit resurrected old code")
	}
	if err = f.s.SetPolicy(ctx, f.p, f.ws, &pb.PutIdentityPolicyRequest{Version: uint64(max(policy.Version, 0)), Mode: pb.IdentityPolicyMode_IDENTITY_POLICY_MODE_ENFORCED}); err != nil {
		t.Fatal(err)
	}
}
