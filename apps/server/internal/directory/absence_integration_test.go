//go:build integration

package directory

import (
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/go-ldap/ldap/v3"
	"github.com/google/uuid"
)

func TestDirectoryFirstAbsenceRevokesManagedAccess(t *testing.T) {
	f := newDirectoryFixture(t)
	ctx := t.Context()
	f.sync(t)
	if err := f.service.Link(ctx, f.p, f.ws, f.user, f.guid); err != nil {
		t.Fatal(err)
	}
	f.sync(t)
	d := f.service.Identity.DB
	connection, identity, client, consent, grant := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	fixtures := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO workspace_identity_connections(id,workspace_id,name,provider,issuer,client_id,status,tested_version,tested_at) VALUES($1,$2,'Fixture','generic','https://directory.test','fixture','active',1,clock_timestamp())`, []any{connection, f.ws}},
		{`INSERT INTO workspace_external_identities(id,workspace_id,connection_id,user_id,issuer,subject) VALUES($1,$2,$3,$4,'https://directory.test','member')`, []any{identity, f.ws, connection, f.user}},
		{`UPDATE workspace_identity_policies SET mode='enforced' WHERE workspace_id=$1`, []any{f.ws}},
		{`INSERT INTO oauth_clients(id,workspace_id,client_id,name,client_type,auth_method) VALUES($1,$2,$3,'Fixture','public_native','none')`, []any{client, f.ws, client.String()}},
		{`INSERT INTO oauth_consents(id,workspace_id,user_id,client_id,scopes) VALUES($1,$2,$3,$4,ARRAY['openid'])`, []any{consent, f.ws, f.user, client}},
		{`INSERT INTO oauth_grants(id,workspace_id,user_id,client_id,consent_id,session_id,scopes,issuer,client_version,consent_version,policy_version,access_version,entitlement_version,session_version,authenticated_at,expires_at,idle_expires_at) VALUES($1,$2,$3,$4,$5,$6,ARRAY['openid'],'https://directory.test',1,1,1,1,1,1,clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 hour')`, []any{grant, f.ws, f.user, client, consent, f.session}},
	}
	for _, fixture := range fixtures {
		if _, err := d.Pool.Exec(ctx, fixture.sql, fixture.args...); err != nil {
			t.Fatal(err)
		}
	}
	loader := identitypolicy.NewSQLLoader(d.Q, f.service.Identity.Edition)
	check := func() identitypolicy.Decision {
		t.Helper()
		st, err := loader.LoadIdentityState(ctx, f.session, f.user, f.ws)
		if err != nil {
			t.Fatal(err)
		}
		return identitypolicy.Evaluate(time.Now(), st, identitypolicy.WorkspaceRead)
	}
	freshSSO := func() {
		t.Helper()
		st, err := loader.LoadIdentityState(ctx, f.session, f.user, f.ws)
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now()
		if _, err = d.Q.UpsertWorkspaceAssurance(ctx, sqlc.UpsertWorkspaceAssuranceParams{SessionID: f.session, WorkspaceID: f.ws, UserID: f.user, ConnectionID: connection, IdentityID: identity, AuthenticatedAt: now, ValidUntil: now.Add(time.Hour), PolicyVersion: st.Policy.Version, AccessVersion: st.AccessVersion, ConnectionVersion: 1, IdentityVersion: 1, EntitlementVersion: st.EntitlementVersion, SessionVersion: st.Principal.Version}); err != nil {
			t.Fatal(err)
		}
	}
	freshSSO()
	scoped, err := d.Q.CreateScopedIdentitySession(ctx, sqlc.CreateScopedIdentitySessionParams{UserID: f.user, RefreshTokenHash: identitycrypto.Hash(uuid.NewString()), ExpiresAt: time.Now().Add(time.Hour), AuthorityKind: "workspace_sso", AuthorityWorkspaceID: &f.ws, AuthorityConnectionID: &connection})
	if err != nil {
		t.Fatal(err)
	}
	if decision := check(); !decision.Allowed {
		t.Fatalf("fresh managed member denied: %+v", decision)
	}
	// A failed second page has no authoritative knowledge of the omitted managed GUID.
	f.ldap.mu.Lock()
	f.ldap.entries = []*ldap.Entry{fixtureEntry("33221100554477668899aabbccddee00", "512"), fixtureEntry("33221100554477668899aabbccddee01", "512")}
	f.ldap.failPage = 1
	f.ldap.mu.Unlock()
	before, err := d.Q.GetWorkspaceIdentityDirectory(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.Sync(ctx, f.ws); err == nil {
		t.Fatal("partial snapshot succeeded")
	}
	after, err := d.Q.GetWorkspaceIdentityDirectory(ctx, f.ws)
	if err != nil || after.Generation != before.Generation || !after.LastSuccessAt.Equal(*before.LastSuccessAt) || f.object(t).MissingFullScans != 0 || f.object(t).Status != "active" || !check().Allowed {
		t.Fatalf("partial snapshot changed managed access: %v", err)
	}
	f.ldap.mu.Lock()
	f.ldap.entries = nil
	f.ldap.failPage = -1
	f.ldap.mu.Unlock()
	f.sync(t)
	object := f.object(t)
	if object.Status != "disabled" || object.MissingFullScans != 1 || check().Allowed {
		t.Fatalf("first authoritative absence retained access: object=%+v decision=%+v", object, check())
	}
	assertRevoked := func() {
		t.Helper()
		row, err := d.Q.GetSession(ctx, scoped.ID)
		if err != nil || row.RevokedAt == nil {
			t.Fatalf("directory absence failed scoped session revocation: %v", err)
		}
		var assuranceRevoked, grantRevoked bool
		if err := d.Pool.QueryRow(ctx, `SELECT a.revoked_at IS NOT NULL,g.revoked_at IS NOT NULL FROM session_workspace_assurances a JOIN oauth_grants g ON g.workspace_id=a.workspace_id AND g.user_id=a.user_id WHERE a.workspace_id=$1 AND a.session_id=$2 AND g.id=$3`, f.ws, f.session, grant).Scan(&assuranceRevoked, &grantRevoked); err != nil || !assuranceRevoked || !grantRevoked {
			t.Fatalf("directory absence failed durable revocation: assurance=%v grant=%v err=%v", assuranceRevoked, grantRevoked, err)
		}
	}
	assertRevoked()
	f.sync(t)
	if object := f.object(t); object.Status != "deleted" || object.MissingFullScans != 2 {
		t.Fatalf("second authoritative absence did not finalize tombstone: %+v", object)
	}
	f.ldap.mu.Lock()
	f.ldap.entries = []*ldap.Entry{fixtureEntry("33221100554477668899aabbccddeeff", "512")}
	f.ldap.mu.Unlock()
	f.sync(t)
	if object := f.object(t); object.Status != "active" || object.MissingFullScans != 0 {
		t.Fatalf("eligible return not available for fresh SSO: %+v", object)
	}
	if decision := check(); decision.Allowed || decision.Reason != identitypolicy.SSORequired {
		t.Fatalf("eligible return reused old proof: %+v", decision)
	}
	assertRevoked()
	freshSSO()
	if !check().Allowed {
		t.Fatal("fresh SSO did not restore eligible member access")
	}
	var revoked bool
	if err = d.Pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM oauth_grants WHERE id=$1`, grant).Scan(&revoked); err != nil || !revoked {
		t.Fatal("fresh SSO resurrected old OAuth grant")
	}
	if _, err = d.Q.UpsertIdentityAccess(ctx, sqlc.UpsertIdentityAccessParams{WorkspaceID: f.ws, UserID: f.user, Status: "suspended", Reason: "manual_ban"}); err != nil {
		t.Fatal(err)
	}
	f.ldap.mu.Lock()
	f.ldap.entries = nil
	f.ldap.mu.Unlock()
	f.sync(t)
	f.ldap.mu.Lock()
	f.ldap.entries = []*ldap.Entry{fixtureEntry("33221100554477668899aabbccddeeff", "512")}
	f.ldap.mu.Unlock()
	f.sync(t)
	access, err := d.Q.GetIdentityAccess(ctx, sqlc.GetIdentityAccessParams{WorkspaceID: f.ws, UserID: f.user})
	if err != nil || access.Status != "suspended" || access.Reason != "manual_ban" || check().Allowed {
		t.Fatalf("return from absence cleared manual ban: %+v %v", access, err)
	}
	st, err := loader.LoadIdentityState(ctx, f.session, f.user, f.otherWS)
	if err != nil || !identitypolicy.Evaluate(time.Now(), st, identitypolicy.WorkspaceRead).Allowed {
		t.Fatal("managed absence affected independent workspace/local session")
	}
}
