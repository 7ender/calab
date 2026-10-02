//go:build integration

package db

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func identityTestDB(t *testing.T) *DB {
	t.Helper()
	ctx := context.Background()
	adminURL := envOr("TEST_DATABASE_URL", os.Getenv("TEST_PG_URL"))
	if adminURL == "" {
		t.Fatal("TEST_DATABASE_URL (or TEST_PG_URL) required")
	}
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close(ctx) })
	name := "identity_mig_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)"); err != nil {
			t.Errorf("drop fixture: %v", err)
		}
	})
	parsed, err := url.Parse(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Path = "/" + name
	d, err := Connect(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	if err = d.MigrateTo(ctx, 54); err != nil {
		t.Fatal(err)
	}
	return d
}
func mustIdentitySQL(t *testing.T, d *DB, query string, args ...any) {
	t.Helper()
	if _, err := d.Pool.Exec(context.Background(), query, args...); err != nil {
		t.Fatalf("fixture SQL: %v", err)
	}
}
func rejectIdentitySQL(t *testing.T, d *DB, code, query string, args ...any) {
	t.Helper()
	_, err := d.Pool.Exec(context.Background(), query, args...)
	var pe *pgconn.PgError
	if !errors.As(err, &pe) || pe.Code != code {
		t.Fatalf("want SQLSTATE %s, got %v", code, err)
	}
}
func TestIdentityFoundationMigration(t *testing.T) {
	ctx := context.Background()
	d := identityTestDB(t)
	owner, other, wsA, wsB, session := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	mustIdentitySQL(t, d, `INSERT INTO users(id,email,display_name) VALUES($1,'owner@identity.test','Owner'),($2,'other@identity.test','Other')`, owner, other)
	mustIdentitySQL(t, d, `INSERT INTO workspaces(id,slug,name,owner_id) VALUES($1,'identity-a','A',$3),($2,'identity-b','B',$3)`, wsA, wsB, owner)
	mustIdentitySQL(t, d, `INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$3,'owner'),($1,$4,'member'),($2,$3,'owner'),($2,$4,'member')`, wsA, wsB, owner, other)
	mustIdentitySQL(t, d, `INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`, session, owner, identitycrypto.Hash("legacy"))
	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	t.Run("legacy_and_round_trip", func(t *testing.T) {
		s, err := d.Q.GetSession(ctx, session)
		if err != nil || s.AuthorityKind != "local_account" || s.LocalAuthenticatedAt != nil || s.RecoveryAuthenticatedAt != nil || s.AuthorityWorkspaceID != nil {
			t.Fatalf("legacy gained proof %v %+v", err, s)
		}
		var proofs, grants int
		if err = d.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM session_workspace_assurances),(SELECT count(*) FROM workspace_identity_grants)`).Scan(&proofs, &grants); err != nil || proofs != 0 || grants != 0 {
			t.Fatal("migration minted proof/entitlement")
		}
		loader := identitypolicy.NewSQLLoader(d.Q, identitypolicy.EntitlementConfig{Edition: "cloud"})
		state, err := loader.LoadIdentityState(ctx, session, owner, wsA)
		if err != nil || !identitypolicy.Evaluate(time.Now(), state, identitypolicy.WorkspaceRead).Allowed {
			t.Fatalf("legacy gate %v %+v", err, state)
		}
		provider, err := newProvider(d)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = provider.DownTo(ctx, 54); err != nil {
			t.Fatal(err)
		}
		var n int
		if err = d.Pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE id=$1`, session).Scan(&n); err != nil || n != 1 {
			t.Fatal("legacy session lost on down")
		}
		if err = d.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
	})
	connectionA, connectionB, identityA, identityOther := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	mustIdentitySQL(t, d, `INSERT INTO workspace_identity_connections(id,workspace_id,name,provider,issuer,client_id,status,tested_version,tested_at) VALUES($1,$2,'A','generic','https://idp-a.test','client-a','active',1,now()),($3,$4,'B','generic','https://idp-b.test','client-b','active',1,now())`, connectionA, wsA, connectionB, wsB)
	mustIdentitySQL(t, d, `INSERT INTO workspace_external_identities(id,workspace_id,connection_id,user_id,issuer,subject) VALUES($1,$2,$3,$4,'https://idp-a.test','owner-sub'),($5,$2,$3,$6,'https://idp-a.test','other-sub')`, identityA, wsA, connectionA, owner, identityOther, other)
	t.Run("scoped_authority_and_cross_workspace_FK", func(t *testing.T) {
		rejectIdentitySQL(t, d, "23514", `UPDATE sessions SET authority_kind='workspace_sso',authority_workspace_id=$2,authority_connection_id=$3 WHERE id=$1`, session, wsA, connectionA)
		rejectIdentitySQL(t, d, "23514", `INSERT INTO sessions(user_id,refresh_token_hash,expires_at,authority_kind) VALUES($1,$2,now()+interval '1 hour','workspace_sso')`, owner, identitycrypto.Hash("scope"))
		rejectIdentitySQL(t, d, "23503", `INSERT INTO sessions(user_id,refresh_token_hash,expires_at,authority_kind,authority_workspace_id,authority_connection_id) VALUES($1,$2,now()+interval '1 hour','workspace_sso',$3,$4)`, owner, identitycrypto.Hash("scope"), wsA, connectionB)
		rejectIdentitySQL(t, d, "23505", `INSERT INTO workspace_identity_connections(workspace_id,name,provider,issuer,client_id,status) VALUES($1,'second','generic','https://new.test','new','active')`, wsA)
		rejectIdentitySQL(t, d, "23503", `INSERT INTO workspace_external_identities(workspace_id,connection_id,user_id,issuer,subject) VALUES($1,$2,$3,'https://idp-b.test','cross')`, wsA, connectionB, owner)
		rejectIdentitySQL(t, d, "23503", `INSERT INTO session_workspace_assurances(session_id,workspace_id,user_id,connection_id,identity_id,authenticated_at,valid_until,policy_version,access_version,connection_version,identity_version,entitlement_version,session_version) VALUES($1,$2,$3,$4,$5,now(),now()+interval '30 minutes',1,1,1,1,1,1)`, session, wsA, owner, connectionA, identityOther)
		rejectIdentitySQL(t, d, "23514", `INSERT INTO sessions(user_id,refresh_token_hash,expires_at,authority_kind,authority_workspace_id,recovery_authenticated_at) VALUES($1,$2,now()+interval '11 minutes','recovery',$3,now())`, owner, identitycrypto.Hash("recovery"), wsA)
	})
	t.Run("positive_grants_and_durable_epochs", func(t *testing.T) {
		if _, err := d.Q.EnsureIdentityPolicy(ctx, wsA); err != nil {
			t.Fatal(err)
		}
		mustIdentitySQL(t, d, `INSERT INTO workspace_plans(workspace_id,plan,limits) VALUES($1,'enterprise','{}')`, wsA)
		for _, feature := range []string{"corporate_sso", "directory_sync", "oauth_provider"} {
			if _, err := d.Q.UpsertIdentityGrant(ctx, sqlc.UpsertIdentityGrantParams{WorkspaceID: wsA, Feature: feature, Enabled: true, Source: "cloud_business"}); err != nil {
				t.Fatal(err)
			}
		}
		before, err := d.Q.GetIdentityPolicy(ctx, wsA)
		if err != nil {
			t.Fatal(err)
		}
		mustIdentitySQL(t, d, `DELETE FROM workspace_identity_grants WHERE workspace_id=$1 AND feature='directory_sync'`, wsA)
		after, err := d.Q.GetIdentityPolicy(ctx, wsA)
		if err != nil || after.EntitlementVersion <= before.EntitlementVersion {
			t.Fatal("grant removal did not invalidate proofs")
		}
		loader := identitypolicy.NewSQLLoader(d.Q, identitypolicy.EntitlementConfig{Edition: "cloud"})
		state, err := loader.LoadIdentityState(ctx, session, owner, wsA)
		if err != nil {
			t.Fatal(err)
		}
		if !identitypolicy.RequireEntitlement(time.Now(), wsA, state.Grants[identitypolicy.SSO], identitypolicy.SSO).Allowed {
			t.Fatal("Business denied")
		}
		mustIdentitySQL(t, d, `UPDATE workspace_plans SET valid_until=now()-interval '1 second' WHERE workspace_id=$1`, wsA)
		state, err = loader.LoadIdentityState(ctx, session, owner, wsA)
		if err != nil {
			t.Fatal(err)
		}
		if identitypolicy.RequireEntitlement(time.Now(), wsA, state.Grants[identitypolicy.SSO], identitypolicy.SSO).Allowed {
			t.Fatal("expired Business allowed")
		}
		mustIdentitySQL(t, d, `UPDATE workspace_plans SET valid_until=NULL WHERE workspace_id=$1`, wsA)
	})
	clientA, clientB, consent, grant := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	mustIdentitySQL(t, d, `INSERT INTO oauth_clients(id,workspace_id,client_id,name,client_type,auth_method) VALUES($1,$2,'client-public-a','A','public_native','none'),($3,$4,'client-public-b','B','public_native','none')`, clientA, wsA, clientB, wsB)
	mustIdentitySQL(t, d, `INSERT INTO oauth_consents(id,workspace_id,user_id,client_id,scopes,refresh_allowed) VALUES($1,$2,$3,$4,ARRAY['openid'],true)`, consent, wsA, owner, clientA)
	mustIdentitySQL(t, d, `INSERT INTO oauth_grants(id,workspace_id,user_id,client_id,consent_id,session_id,scopes,issuer,client_version,consent_version,policy_version,access_version,entitlement_version,session_version,authenticated_at,expires_at,idle_expires_at) VALUES($1,$2,$3,$4,$5,$6,ARRAY['openid'],'https://issuer.test',1,1,1,1,1,1,now(),now()+interval '8 hours',now()+interval '30 minutes')`, grant, wsA, owner, clientA, consent, session)
	t.Run("OAuth_boundaries_subject_and_refresh_optin", func(t *testing.T) {
		rejectIdentitySQL(t, d, "23503", `INSERT INTO oauth_client_redirects(workspace_id,client_id,redirect_uri) VALUES($1,$2,'https://rp.test/callback')`, wsA, clientB)
		rejectIdentitySQL(t, d, "23503", `INSERT INTO oauth_consents(workspace_id,user_id,client_id,scopes) VALUES($1,$2,$3,ARRAY['openid'])`, wsA, owner, clientB)
		rejectIdentitySQL(t, d, "23514", `UPDATE oauth_clients SET client_type='public_spa' WHERE id=$1`, clientA)
		rejectIdentitySQL(t, d, "23514", `UPDATE oauth_clients SET scopes=ARRAY['openid','offline_access'] WHERE id=$1`, clientA)
		subject, err := identitycrypto.Secret()
		if err != nil {
			t.Fatal(err)
		}
		first, err := d.Q.UpsertOAuthSubject(ctx, sqlc.UpsertOAuthSubjectParams{WorkspaceID: wsA, UserID: owner, Subject: subject})
		if err != nil {
			t.Fatal(err)
		}
		replacement, err := identitycrypto.Secret()
		if err != nil {
			t.Fatal(err)
		}
		again, err := d.Q.UpsertOAuthSubject(ctx, sqlc.UpsertOAuthSubjectParams{WorkspaceID: wsA, UserID: owner, Subject: replacement})
		if err != nil || again.Subject != first.Subject {
			t.Fatal("subject reassigned")
		}
		rejectIdentitySQL(t, d, "23514", `UPDATE oauth_subjects SET user_id=$3 WHERE workspace_id=$1 AND user_id=$2`, wsA, owner, other)
	})
	codeHash := identitycrypto.Hash("code-256-bit-fixture")
	challenge, err := identitycrypto.S256(strings.Repeat("A", 43))
	if err != nil {
		t.Fatal(err)
	}
	codeParams := sqlc.ConsumeOAuthCodeParams{WorkspaceID: wsA, ClientID: clientA, CodeHash: codeHash, RedirectUri: "https://rp.test/callback", PkceChallenge: challenge}
	t.Run("code_binding_atomic_consume_and_rollback", func(t *testing.T) {
		mustIdentitySQL(t, d, `INSERT INTO oauth_authorization_codes(workspace_id,grant_id,user_id,client_id,code_hash,redirect_uri,pkce_challenge,nonce,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'nonce',now()+interval '60 seconds')`, wsA, grant, owner, clientA, codeHash, codeParams.RedirectUri, challenge)
		wrong := codeParams
		wrong.ClientID = clientB
		if _, err := d.Q.ConsumeOAuthCode(ctx, wrong); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("wrong client consumed code")
		}
		wrong = codeParams
		wrong.PkceChallenge = strings.Repeat("B", 43)
		if _, err := d.Q.ConsumeOAuthCode(ctx, wrong); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("wrong verifier consumed code")
		}
		rollback := errors.New("token insert failed")
		err := d.Tx(ctx, func(q *sqlc.Queries) error {
			if _, err := q.ConsumeOAuthCode(ctx, codeParams); err != nil {
				return err
			}
			return rollback
		})
		if !errors.Is(err, rollback) {
			t.Fatal(err)
		}
		var success atomic.Int32
		var unexpected atomic.Int32
		var wg sync.WaitGroup
		for i := 0; i < 16; i++ {
			wg.Go(func() {
				_, err := d.Q.ConsumeOAuthCode(ctx, codeParams)
				if err == nil {
					success.Add(1)
				} else if !errors.Is(err, pgx.ErrNoRows) {
					unexpected.Add(1)
				}
			})
		}
		wg.Wait()
		if success.Load() != 1 || unexpected.Load() != 0 {
			t.Fatalf("16 concurrent consumers: successes %d errors %d", success.Load(), unexpected.Load())
		}
	})
	refreshHash := identitycrypto.Hash("refresh-256-bit-fixture")
	t.Run("refresh_atomic_consume_replay_client_isolation", func(t *testing.T) {
		mustIdentitySQL(t, d, `INSERT INTO oauth_tokens(workspace_id,grant_id,user_id,client_id,token_hash,token_type,generation,expires_at) VALUES($1,$2,$3,$4,$5,'refresh',1,now()+interval '8 hours')`, wsA, grant, owner, clientA, refreshHash)
		wrong := sqlc.ConsumeOAuthRefreshParams{WorkspaceID: wsA, ClientID: clientB, TokenHash: refreshHash}
		if _, err := d.Q.ConsumeOAuthRefresh(ctx, wrong); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("wrong client consumed refresh")
		}
		params := sqlc.ConsumeOAuthRefreshParams{WorkspaceID: wsA, ClientID: clientA, TokenHash: refreshHash}
		var successes atomic.Int32
		var unexpected atomic.Int32
		var wg sync.WaitGroup
		for i := 0; i < 16; i++ {
			wg.Go(func() {
				_, err := d.Q.ConsumeOAuthRefresh(ctx, params)
				if err == nil {
					successes.Add(1)
				} else if !errors.Is(err, pgx.ErrNoRows) {
					unexpected.Add(1)
				}
			})
		}
		wg.Wait()
		if successes.Load() != 1 || unexpected.Load() != 0 {
			t.Fatal("refresh was not single use")
		}
		if _, err := d.Q.RevokeOAuthGrantForReplay(ctx, sqlc.RevokeOAuthGrantForReplayParams{WorkspaceID: wsA, ClientID: clientB, TokenHash: refreshHash}); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("wrong client revoked family")
		}
		revoked, err := d.Q.RevokeOAuthGrantForReplay(ctx, sqlc.RevokeOAuthGrantForReplayParams{WorkspaceID: wsA, ClientID: clientA, TokenHash: refreshHash})
		if err != nil || revoked.RevokedAt == nil || revoked.RevokedReason == nil || *revoked.RevokedReason != "refresh_reuse" {
			t.Fatalf("replay did not revoke %v", err)
		}
		if _, err = d.Q.ConsumeOAuthRefresh(ctx, params); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("revoked family consumed")
		}
	})
	t.Run("directory_staging_and_scoped_staleness", func(t *testing.T) {
		directory, err := d.Q.ReserveIdentityID(ctx)
		if err != nil {
			t.Fatal(err)
		}
		mustIdentitySQL(t, d, `INSERT INTO workspace_directories(id,workspace_id,name,host,url,base_dn,bind_dn,bind_secret_box,last_success_at) VALUES($1,$2,'AD','dc.identity.test','ldaps://dc.identity.test:636','DC=test','CN=reader','\x01',now()-interval '61 minutes')`, directory, wsA)
		mustIdentitySQL(t, d, `INSERT INTO directory_objects(workspace_id,directory_id,object_guid,user_id,distinguished_name,status) VALUES($1,$2,$3,$4,'CN=owner','active')`, wsA, directory, uuid.New(), owner)
		rejectIdentitySQL(t, d, "23505", `INSERT INTO workspace_directories(workspace_id,name,host,url,base_dn,bind_dn,bind_secret_box) VALUES($1,'AD2','dc.test','ldaps://dc.test','DC=test','reader','\x01')`, wsA)
		loader := identitypolicy.NewSQLLoader(d.Q, identitypolicy.EntitlementConfig{Edition: "cloud"})
		if _, err = d.Q.UpsertIdentityGrant(ctx, sqlc.UpsertIdentityGrantParams{WorkspaceID: wsA, Feature: "directory_sync", Enabled: true, Source: "cloud_business"}); err != nil {
			t.Fatal(err)
		}
		state, err := loader.LoadIdentityState(ctx, session, owner, wsA)
		if err != nil {
			t.Fatal(err)
		}
		if decision := identitypolicy.Evaluate(time.Now(), state, identitypolicy.WorkspaceRead); decision.Allowed || decision.Reason != identitypolicy.DirectoryStale {
			t.Fatalf("stale directory allowed %+v", decision)
		}
		state, err = loader.LoadIdentityState(ctx, session, owner, wsB)
		if err != nil || !identitypolicy.Evaluate(time.Now(), state, identitypolicy.WorkspaceRead).Allowed {
			t.Fatal("A stale directory blocked B")
		}
		// Staging is invisible until a complete generation is published.
		run := uuid.New()
		mustIdentitySQL(t, d, `INSERT INTO directory_sync_runs(id,workspace_id,directory_id,full_scan,config_version,generation,lease_until,status) VALUES($1,$2,$3,true,1,1,clock_timestamp()+interval '1 minute','running')`, run, wsA, directory)
		publish := sqlc.PublishDirectorySuccessParams{WorkspaceID: wsA, DirectoryID: directory, ConfigVersion: 1, Generation: 1, RunID: run}
		if _, err := d.Q.PublishDirectorySuccess(ctx, publish); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("incomplete scan published eligibility")
		}
		mustIdentitySQL(t, d, `UPDATE directory_sync_runs SET status='succeeded',complete=true WHERE id=$1`, run)
		if _, err := d.Q.PublishDirectorySuccess(ctx, publish); err != nil {
			t.Fatal(err)
		}
		if _, err := d.Q.PublishDirectorySuccess(ctx, publish); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("generation replay published twice")
		}
		objects, err := d.Q.ListDirectoryObjects(ctx, sqlc.ListDirectoryObjectsParams{WorkspaceID: wsA, LimitCount: 10})
		if err != nil || len(objects) != 1 {
			t.Fatal("managed object missing")
		}
		snapshot := sqlc.UpdateDirectoryObjectSnapshotParams{WorkspaceID: wsA, DirectoryID: directory, ID: objects[0].ID, ExpectedVersion: objects[0].Version, DistinguishedName: "CN=renamed-owner", Status: "active", LastSeenRunID: &run, MissingFullScans: 1}
		updated, err := d.Q.UpdateDirectoryObjectSnapshot(ctx, snapshot)
		if err != nil || updated.LastSeenRunID == nil || *updated.LastSeenRunID != run || updated.MissingFullScans != 1 || updated.Version != objects[0].Version+1 {
			t.Fatal("snapshot/provenance update failed")
		}
		if _, err := d.Q.UpdateDirectoryObjectSnapshot(ctx, snapshot); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("stale snapshot overwrote current generation")
		}
		secondDirectory, err := d.Q.ReserveIdentityID(ctx)
		if err != nil {
			t.Fatal(err)
		}
		mustIdentitySQL(t, d, `INSERT INTO workspace_directories(id,workspace_id,name,host,url,base_dn,bind_dn,bind_secret_box) VALUES($1,$2,'AD-B','dc-b.test','ldaps://dc-b.test','DC=test','reader','\x01')`, secondDirectory, wsB)
		firstPage, err := d.Q.ListEnabledIdentityDirectoriesAfter(ctx, sqlc.ListEnabledIdentityDirectoriesAfterParams{LimitCount: 1})
		if err != nil || len(firstPage) != 1 {
			t.Fatal("first scheduling page")
		}
		secondPage, err := d.Q.ListEnabledIdentityDirectoriesAfter(ctx, sqlc.ListEnabledIdentityDirectoriesAfterParams{LimitCount: 1, AfterID: &firstPage[0].ID})
		if err != nil || len(secondPage) != 1 || secondPage[0].ID == firstPage[0].ID {
			t.Fatal("directory scheduler cannot progress")
		}
		finalPage, err := d.Q.ListEnabledIdentityDirectoriesAfter(ctx, sqlc.ListEnabledIdentityDirectoriesAfterParams{LimitCount: 1, AfterID: &secondPage[0].ID})
		if err != nil || len(finalPage) != 0 {
			t.Fatal("directory cursor did not finish")
		}
		var globallyDisabled bool
		if err = d.Pool.QueryRow(ctx, `SELECT disabled_at IS NOT NULL FROM users WHERE id=$1`, owner).Scan(&globallyDisabled); err != nil || globallyDisabled {
			t.Fatal("scoped stale altered global account")
		}
	})
	t.Run("tombstone_and_workspace_user_deletion", func(t *testing.T) {
		mustIdentitySQL(t, d, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, wsA, other)
		var count int
		if err := d.Pool.QueryRow(ctx, `SELECT count(*) FROM workspace_external_identities WHERE workspace_id=$1 AND user_id=$2`, wsA, other).Scan(&count); err != nil || count != 1 {
			t.Fatal("membership deletion lost tombstone")
		}
		mustIdentitySQL(t, d, `DELETE FROM users WHERE id=$1`, other)
		mustIdentitySQL(t, d, `DELETE FROM workspaces WHERE id=$1`, wsA)
		if err := d.Pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE id=$1`, wsB).Scan(&count); err != nil || count != 1 {
			t.Fatal("workspace cascade touched B")
		}
		current, err := d.Q.GetSession(ctx, session)
		if err != nil || current.RevokedAt != nil {
			t.Fatal("workspace deletion revoked global local session")
		}
	})
}

// A transaction's stable now() must not extend a code's absolute lifetime.
func assertIdentityLockDeadline(t *testing.T, d *DB, id uuid.UUID, resetSQL, lockSQL string, consume func(context.Context) error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	mustIdentitySQL(t, d, resetSQL, id)
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, lockSQL, id); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { result <- consume(ctx) }()
	select {
	case err := <-result:
		t.Fatalf("consumer did not wait on row lock: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	time.Sleep(650 * time.Millisecond)
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-result:
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("expired row consumed after unchanged lock holder released: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestIdentityCodeDeadlineAfterTransactionWait(t *testing.T) {
	ctx := context.Background()
	d := identityTestDB(t)
	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	owner, ws, session, client, consent, grant := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	mustIdentitySQL(t, d, `INSERT INTO users(id,email,display_name) VALUES($1,'deadline@identity.test','D')`, owner)
	mustIdentitySQL(t, d, `INSERT INTO workspaces(id,slug,name,owner_id) VALUES($1,'deadline-test','D',$2)`, ws, owner)
	mustIdentitySQL(t, d, `INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`, session, owner, identitycrypto.Hash("session"))
	mustIdentitySQL(t, d, `INSERT INTO oauth_clients(id,workspace_id,client_id,name,client_type,auth_method) VALUES($1,$2,'deadline-client','D','public_native','none')`, client, ws)
	mustIdentitySQL(t, d, `INSERT INTO oauth_consents(id,workspace_id,user_id,client_id,scopes) VALUES($1,$2,$3,$4,ARRAY['openid'])`, consent, ws, owner, client)
	mustIdentitySQL(t, d, `INSERT INTO oauth_grants(id,workspace_id,user_id,client_id,consent_id,session_id,scopes,issuer,client_version,consent_version,policy_version,access_version,entitlement_version,session_version,authenticated_at,expires_at,idle_expires_at) VALUES($1,$2,$3,$4,$5,$6,ARRAY['openid'],'https://issuer.test',1,1,1,1,1,1,now(),now()+interval '1 hour',now()+interval '30 minutes')`, grant, ws, owner, client, consent, session)
	challenge := strings.Repeat("A", 43)
	hash := identitycrypto.Hash("deadline-code")
	mustIdentitySQL(t, d, `INSERT INTO oauth_authorization_codes(workspace_id,grant_id,user_id,client_id,code_hash,redirect_uri,pkce_challenge,nonce,expires_at) VALUES($1,$2,$3,$4,$5,'https://rp.test/cb',$6,'nonce',clock_timestamp()+interval '500 milliseconds')`, ws, grant, owner, client, hash, challenge)
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Begin the transaction before expiry, then consume after the real deadline.
	if _, err = tx.Exec(ctx, `SELECT now()`); err != nil {
		t.Fatal(err)
	}
	time.Sleep(750 * time.Millisecond)
	_, err = d.Q.WithTx(tx).ConsumeOAuthCode(ctx, sqlc.ConsumeOAuthCodeParams{WorkspaceID: ws, ClientID: client, CodeHash: hash, RedirectUri: "https://rp.test/cb", PkceChallenge: challenge})
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("expired code accepted after transaction wait: %v", err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	t.Run("issuance_after_transaction_delay", func(t *testing.T) {
		issueTx, err := d.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = issueTx.Rollback(ctx) }()
		if _, err = issueTx.Exec(ctx, `SELECT now()`); err != nil {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
		q := d.Q.WithTx(issueTx)
		now := time.Now()
		if _, err = q.CreateOAuthCode(ctx, sqlc.CreateOAuthCodeParams{WorkspaceID: ws, GrantID: grant, UserID: owner, ClientID: client, CodeHash: identitycrypto.Hash("issued-code"), RedirectUri: "https://rp.test/cb", PkceChallenge: challenge, Nonce: "nonce", ExpiresAt: now.Add(time.Minute)}); err != nil {
			t.Fatalf("valid code issuance %v", err)
		}
		if _, err = q.CreateOAuthToken(ctx, sqlc.CreateOAuthTokenParams{WorkspaceID: ws, GrantID: grant, UserID: owner, ClientID: client, TokenHash: identitycrypto.Hash("issued-access"), TokenType: "access", Generation: 1, ExpiresAt: now.Add(5 * time.Minute)}); err != nil {
			t.Fatalf("valid token issuance %v", err)
		}
		if _, err = q.CreateOAuthGrant(ctx, sqlc.CreateOAuthGrantParams{WorkspaceID: ws, UserID: owner, ClientID: client, ConsentID: consent, SessionID: session, Scopes: []string{"openid"}, Issuer: "https://issuer.test", ClientVersion: 1, ConsentVersion: 1, PolicyVersion: 1, AccessVersion: 1, SessionVersion: 1, EntitlementVersion: 1, AuthenticatedAt: now, ExpiresAt: now.Add(8 * time.Hour), IdleExpiresAt: now.Add(30 * time.Minute)}); err != nil {
			t.Fatalf("valid grant issuance %v", err)
		}
		if err = issueTx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("code_lock_only_holder", func(t *testing.T) {
		var id uuid.UUID
		if err := d.Pool.QueryRow(ctx, `SELECT id FROM oauth_authorization_codes WHERE code_hash=$1`, hash).Scan(&id); err != nil {
			t.Fatal(err)
		}
		assertIdentityLockDeadline(t, d, id, `UPDATE oauth_authorization_codes SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1`, `SELECT id FROM oauth_authorization_codes WHERE id=$1 FOR UPDATE`, func(ctx context.Context) error {
			_, err := d.Q.ConsumeOAuthCode(ctx, sqlc.ConsumeOAuthCodeParams{WorkspaceID: ws, ClientID: client, CodeHash: hash, RedirectUri: "https://rp.test/cb", PkceChallenge: challenge})
			return err
		})
	})
	refreshHash := identitycrypto.Hash("deadline-refresh")
	var refreshID uuid.UUID
	if err = d.Pool.QueryRow(ctx, `INSERT INTO oauth_tokens(workspace_id,grant_id,user_id,client_id,token_hash,token_type,generation,expires_at) VALUES($1,$2,$3,$4,$5,'refresh',1,clock_timestamp()+interval '1 hour') RETURNING id`, ws, grant, owner, client, refreshHash).Scan(&refreshID); err != nil {
		t.Fatal(err)
	}
	t.Run("refresh_lock_only_holder", func(t *testing.T) {
		assertIdentityLockDeadline(t, d, refreshID, `UPDATE oauth_tokens SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1`, `SELECT id FROM oauth_tokens WHERE id=$1 FOR UPDATE`, func(ctx context.Context) error {
			_, err := d.Q.ConsumeOAuthRefresh(ctx, sqlc.ConsumeOAuthRefreshParams{WorkspaceID: ws, ClientID: client, TokenHash: refreshHash})
			return err
		})
	})
	connection := uuid.New()
	mustIdentitySQL(t, d, `INSERT INTO workspace_identity_connections(id,workspace_id,name,provider,issuer,client_id) VALUES($1,$2,'IdP','generic','https://idp.test','rp')`, connection, ws)
	flow, hashState, hashBrowser := uuid.New(), identitycrypto.Hash("deadline-state"), identitycrypto.Hash("deadline-browser")
	mustIdentitySQL(t, d, `INSERT INTO identity_login_transactions(id,workspace_id,connection_id,connection_version,purpose,state_hash,browser_hash,nonce_hash,verifier_box,return_uri,expires_at) VALUES($1,$2,$3,1,'login',$4,$5,$6,'\x01','https://app.test',clock_timestamp()+interval '1 minute')`, flow, ws, connection, hashState, hashBrowser, identitycrypto.Hash("nonce"))
	t.Run("SSO_transaction_lock_only_holder", func(t *testing.T) {
		assertIdentityLockDeadline(t, d, flow, `UPDATE identity_login_transactions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1`, `SELECT id FROM identity_login_transactions WHERE id=$1 FOR UPDATE`, func(ctx context.Context) error {
			_, err := d.Q.ConsumeIdentityLoginTransaction(ctx, sqlc.ConsumeIdentityLoginTransactionParams{StateHash: hashState, BrowserHash: hashBrowser, ConnectionID: connection, ConnectionVersion: 1})
			return err
		})
	})
	ticket, ticketHash := uuid.New(), identitycrypto.Hash("deadline-ticket")
	mustIdentitySQL(t, d, `INSERT INTO identity_native_handoffs(id,transaction_id,ticket_hash,challenge,result_box,expires_at) VALUES($1,$2,$3,'challenge','\x01',clock_timestamp()+interval '1 minute')`, ticket, flow, ticketHash)
	t.Run("native_ticket_lock_only_holder", func(t *testing.T) {
		assertIdentityLockDeadline(t, d, ticket, `UPDATE identity_native_handoffs SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1`, `SELECT id FROM identity_native_handoffs WHERE id=$1 FOR UPDATE`, func(ctx context.Context) error {
			_, err := d.Q.ConsumeIdentityNativeHandoff(ctx, sqlc.ConsumeIdentityNativeHandoffParams{TransactionID: flow, TicketHash: ticketHash, Challenge: "challenge"})
			return err
		})
	})
	recovery, recoveryHash := uuid.New(), identitycrypto.Hash("deadline-recovery")
	mustIdentitySQL(t, d, `INSERT INTO workspace_identity_recovery_codes(id,workspace_id,owner_id,code_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 minute')`, recovery, ws, owner, recoveryHash)
	t.Run("recovery_code_lock_only_holder", func(t *testing.T) {
		assertIdentityLockDeadline(t, d, recovery, `UPDATE workspace_identity_recovery_codes SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1`, `SELECT id FROM workspace_identity_recovery_codes WHERE id=$1 FOR UPDATE`, func(ctx context.Context) error {
			_, err := d.Q.ConsumeIdentityRecoveryCode(ctx, sqlc.ConsumeIdentityRecoveryCodeParams{WorkspaceID: ws, OwnerID: owner, CodeHash: recoveryHash})
			return err
		})
	})
}

func TestIdentityRollbackGuard(t *testing.T) {
	ctx := context.Background()
	d := identityTestDB(t)
	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	user, ws := uuid.New(), uuid.New()
	mustIdentitySQL(t, d, `INSERT INTO users(id,email,display_name) VALUES($1,'rollback@identity.test','Owner')`, user)
	mustIdentitySQL(t, d, `INSERT INTO workspaces(id,slug,name,owner_id) VALUES($1,'rollback-test','W',$2)`, ws, user)
	mustIdentitySQL(t, d, `INSERT INTO workspace_identity_policies(workspace_id,mode) VALUES($1,'enforced')`, ws)
	p, err := newProvider(d)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.DownTo(ctx, 54); err == nil {
		t.Fatal("old binary rollback allowed over enforced policy")
	}
	mustIdentitySQL(t, d, `UPDATE workspace_identity_policies SET mode='off' WHERE workspace_id=$1`, ws)
	if _, err = p.DownTo(ctx, 54); err != nil {
		t.Fatal(err)
	}
	if err = d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
}
