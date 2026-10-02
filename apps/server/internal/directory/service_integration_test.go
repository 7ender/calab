//go:build integration

package directory

import (
	"context"
	"errors"
	"testing"
	"time"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/sso"
	"github.com/go-ldap/ldap/v3"
	"github.com/google/uuid"
)

type directoryFixture struct {
	service                           *Service
	ldap                              *ldapFixture
	ws, otherWS, user, owner, session uuid.UUID
	p                                 identitypolicy.Principal
	guid                              uuid.UUID
}

func newDirectoryFixture(t *testing.T) *directoryFixture {
	t.Helper()
	ctx := context.Background()
	d := dbtest.Connect(t)
	var err error
	keys, err := identitycrypto.New("fixture", map[string][]byte{"fixture": make([]byte, 32)})
	if err != nil {
		t.Fatal(err)
	}
	ldapFixture, client, c := newLDAPFixture(t)
	ldapFixture.entries = []*ldap.Entry{fixtureEntry("33221100554477668899aabbccddeeff", "512")}
	owner, user, ws, other, ownerSession, session := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	now := time.Now()
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	fixtures := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,display_name)VALUES($1,$2,'Owner'),($3,$4,'Member')`, []any{owner, owner.String() + "@directory.test", user, user.String() + "@directory.test"}},
		{`INSERT INTO workspaces(id,slug,name,owner_id)VALUES($1,$2,'Directory Fixture',$3),($4,$5,'Other',$3)`, []any{ws, "dir-" + ws.String()[:12], owner, other, "dir-" + other.String()[:12]}},
		{`INSERT INTO workspace_members(workspace_id,user_id,role)VALUES($1,$2,'owner'),($1,$3,'member'),($4,$3,'member')`, []any{ws, owner, user, other}},
		{`INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at,local_authenticated_at)VALUES($1,$2,$3,$4,$5),($6,$7,$3,$4,$5)`, []any{ownerSession, owner, identitycrypto.Hash(uuid.NewString()), now.Add(time.Hour), now, session, user}},
		{`INSERT INTO workspace_plans(workspace_id,plan)VALUES($1,'enterprise') ON CONFLICT(workspace_id) DO UPDATE SET plan='enterprise'`, []any{ws}},
	}
	for _, v := range fixtures {
		if _, err = tx.Exec(ctx, v.sql, v.args...); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
	}
	for _, feature := range []string{"corporate_sso", "directory_sync"} {
		if _, err = d.Q.WithTx(tx).UpsertIdentityGrant(ctx, sqlc.UpsertIdentityGrantParams{WorkspaceID: ws, Feature: feature, Source: "cloud_business", Enabled: true}); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = d.Pool.Exec(ctx, `DELETE FROM workspaces WHERE id=$1 OR id=$2`, ws, other)
		_, _ = d.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1 OR id=$2`, owner, user)
		d.Close()
	})
	service := &Service{Identity: &sso.Service{DB: d, Keys: keys, Edition: identitypolicy.EntitlementConfig{Edition: "cloud"}}, LDAP: client, OperatorCAs: map[string]string{c.Host: c.CaPem}}
	p := identitypolicy.Principal{SessionID: ownerSession, UserID: owner, Authority: identitypolicy.LocalAccount, LocalAuthenticatedAt: now, ExpiresAt: now.Add(time.Hour), Version: 1}
	password := "fixture-password"
	if _, err = service.Put(ctx, p, ws, &pb.PutIdentityDirectoryRequest{Enabled: true, Url: c.Url, BaseDn: c.BaseDn, BindDn: c.BindDn, AllowedGroupDns: c.AllowedGroupDns, BindPassword: &password}); err != nil {
		t.Fatal(err)
	}
	guid := uuid.MustParse("00112233-4455-6677-8899-aabbccddeeff")
	return &directoryFixture{service: service, ldap: ldapFixture, ws: ws, otherWS: other, user: user, owner: owner, session: session, p: p, guid: guid}
}
func (f *directoryFixture) object(t *testing.T) sqlc.DirectoryObject {
	t.Helper()
	c, err := f.service.Identity.DB.Q.GetWorkspaceIdentityDirectory(context.Background(), f.ws)
	if err != nil {
		t.Fatal(err)
	}
	object, err := f.service.Identity.DB.Q.FindDirectoryObjectGUID(context.Background(), sqlc.FindDirectoryObjectGUIDParams{WorkspaceID: f.ws, DirectoryID: c.ID, ObjectGuid: f.guid})
	if err != nil {
		t.Fatal(err)
	}
	return object
}
func (f *directoryFixture) sync(t *testing.T) {
	t.Helper()
	if err := f.service.Sync(context.Background(), f.ws); err != nil {
		t.Fatal(err)
	}
}
func TestDirectoryAtomicLifecycleAndStaleness(t *testing.T) {
	f := newDirectoryFixture(t)
	ctx := context.Background()
	f.sync(t)
	if f.object(t).Status != "unmapped" {
		t.Fatal("created global membership")
	}
	if err := f.service.Link(ctx, f.p, f.ws, f.user, f.guid); err != nil {
		t.Fatal(err)
	}
	f.sync(t)
	if f.object(t).Status != "active" {
		t.Fatal("explicit link not eligible")
	}
	f.ldap.mu.Lock()
	f.ldap.entries = []*ldap.Entry{fixtureEntry("33221100554477668899aabbccddeeff", "514")}
	f.ldap.mu.Unlock()
	f.sync(t)
	if f.object(t).Status != "disabled" {
		t.Fatal("disabled UAC not suspended")
	}
	q := f.service.Identity.DB.Q
	if _, err := q.UpsertIdentityAccess(ctx, sqlc.UpsertIdentityAccessParams{WorkspaceID: f.ws, UserID: f.user, Status: "suspended", Reason: "manual_ban"}); err != nil {
		t.Fatal(err)
	}
	f.ldap.mu.Lock()
	f.ldap.entries = []*ldap.Entry{fixtureEntry("33221100554477668899aabbccddeeff", "512")}
	f.ldap.mu.Unlock()
	f.sync(t)
	access, err := q.GetIdentityAccess(ctx, sqlc.GetIdentityAccessParams{WorkspaceID: f.ws, UserID: f.user})
	if err != nil || access.Status != "suspended" || access.Reason != "manual_ban" || f.object(t).Status != "active" {
		t.Fatal("AD re-enable cleared manual ban")
	}
	loader := identitypolicy.NewSQLLoader(q, f.service.Identity.Edition)
	st, err := loader.LoadIdentityState(ctx, f.session, f.user, f.otherWS)
	if err != nil || !identitypolicy.Evaluate(time.Now(), st, identitypolicy.WorkspaceRead).Allowed {
		t.Fatal("directory changed another workspace")
	}
	f.ldap.mu.Lock()
	f.ldap.entries = nil
	f.ldap.mu.Unlock()
	f.sync(t)
	object := f.object(t)
	if object.Status != "disabled" || object.MissingFullScans != 1 {
		t.Fatal("first authoritative absence did not suspend access before tombstone")
	}
	before, err := q.GetWorkspaceIdentityDirectory(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	f.ldap.mu.Lock()
	f.ldap.failPage = 0
	f.ldap.mu.Unlock()
	if err = f.service.Sync(ctx, f.ws); err == nil {
		t.Fatal("outage counted as success")
	}
	after, err := q.GetWorkspaceIdentityDirectory(ctx, f.ws)
	if err != nil || after.Generation != before.Generation || !after.LastSuccessAt.Equal(*before.LastSuccessAt) || f.object(t).MissingFullScans != 1 {
		t.Fatal("outage deleted/renewed freshness")
	}
	f.ldap.mu.Lock()
	f.ldap.failPage = -1
	f.ldap.mu.Unlock()
	f.sync(t)
	if f.object(t).Status != "deleted" {
		t.Fatal("second authoritative absence ignored")
	}
	if _, err = q.UpsertIdentityAccess(ctx, sqlc.UpsertIdentityAccessParams{WorkspaceID: f.ws, UserID: f.user, Status: "active", Reason: ""}); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Identity.DB.Pool.Exec(ctx, `UPDATE directory_objects SET status='active' WHERE workspace_id=$1;`, f.ws); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Identity.DB.Pool.Exec(ctx, `UPDATE workspace_directories SET last_success_at=now()-interval '61 minutes' WHERE workspace_id=$1`, f.ws); err != nil {
		t.Fatal(err)
	}
	st, err = loader.LoadIdentityState(ctx, f.session, f.user, f.ws)
	if err != nil || identitypolicy.Evaluate(time.Now(), st, identitypolicy.WorkspaceRead).Allowed {
		t.Fatal("stale directory granted access")
	}
	var disabled *time.Time
	if err = f.service.Identity.DB.Pool.QueryRow(ctx, `SELECT disabled_at FROM users WHERE id=$1`, f.user).Scan(&disabled); err != nil || disabled != nil {
		t.Fatal("global account disabled")
	}
}

type blockingScanner struct {
	Scanner
	scanned, release chan struct{}
}

func (b blockingScanner) Scan(ctx context.Context, c sqlc.WorkspaceDirectory, password string) ([]Object, error) {
	result, err := b.Scanner.Scan(ctx, c, password)
	close(b.scanned)
	select {
	case <-b.release:
		return result, err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func TestDirectoryConfigRaceDiscardsSnapshot(t *testing.T) {
	f := newDirectoryFixture(t)
	f.sync(t)
	ctx := context.Background()
	c, err := f.service.Identity.DB.Q.GetWorkspaceIdentityDirectory(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	gate := blockingScanner{Scanner: f.service.LDAP, scanned: make(chan struct{}), release: make(chan struct{})}
	f.service.LDAP = gate
	done := make(chan error, 1)
	go func() { done <- f.service.Sync(ctx, f.ws) }()
	<-gate.scanned
	if _, err = f.service.Put(ctx, f.p, f.ws, &pb.PutIdentityDirectoryRequest{Version: uint64(max(c.Version, 0)), Enabled: true, Url: c.Url, BaseDn: c.BaseDn, BindDn: c.BindDn, AllowedGroupDns: []string{"CN=Different,DC=example,DC=test"}}); err != nil {
		t.Fatal(err)
	}
	close(gate.release)
	if err = <-done; !errors.Is(err, sso.ErrChanged) {
		t.Fatalf("old config published %v", err)
	}
	current, err := f.service.Identity.DB.Q.GetWorkspaceIdentityDirectory(ctx, f.ws)
	if err != nil || current.LastSuccessAt != nil || current.Generation != c.Generation {
		t.Fatal("scope change reused freshness")
	}
}

func TestDirectoryPublishRechecksDatabaseLease(t *testing.T) {
	f := newDirectoryFixture(t)
	f.sync(t)
	ctx := context.Background()
	q := f.service.Identity.DB.Q
	c, err := q.GetWorkspaceIdentityDirectory(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	run, err := q.CreateDirectorySyncRun(ctx, sqlc.CreateDirectorySyncRunParams{WorkspaceID: f.ws, DirectoryID: c.ID, FullScan: true, ConfigVersion: c.Version, Generation: c.Generation + 1, Status: "running", StartedAt: time.Now(), LeaseUntil: time.Now().Add(time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	// The scan captured a still-live lease, but the durable lease expires before commit.
	if _, err = f.service.Identity.DB.Pool.Exec(ctx, `UPDATE directory_sync_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, run.ID); err != nil {
		t.Fatal(err)
	}
	if err = f.service.publish(ctx, c, run, nil); err == nil {
		t.Fatal("expired durable lease published")
	}
	current, err := q.GetWorkspaceIdentityDirectory(ctx, f.ws)
	if err != nil || current.Generation != c.Generation || !current.LastSuccessAt.Equal(*c.LastSuccessAt) {
		t.Fatal("expired publish changed freshness")
	}
	object := f.object(t)
	if object.MissingFullScans != 0 || object.Status != "unmapped" {
		t.Fatal("expired publish changed objects")
	}
	actual, err := q.GetDirectorySyncRun(ctx, sqlc.GetDirectorySyncRunParams{WorkspaceID: f.ws, ID: run.ID})
	if err != nil || actual.Status != "running" {
		t.Fatal("expired publish failed to rollback staged run")
	}
}

type scannerMux map[uuid.UUID]Scanner

func (m scannerMux) Validate(c sqlc.WorkspaceDirectory) error { return m[c.WorkspaceID].Validate(c) }
func (m scannerMux) Scan(ctx context.Context, c sqlc.WorkspaceDirectory, password string) ([]Object, error) {
	return m[c.WorkspaceID].Scan(ctx, c, password)
}
func TestDirectorySchedulerDoesNotBlockHealthyWorkspace(t *testing.T) {
	slow, healthy := newDirectoryFixture(t), newDirectoryFixture(t)
	gate := blockingScanner{Scanner: slow.service.LDAP, scanned: make(chan struct{}), release: make(chan struct{})}
	slow.service.LDAP = scannerMux{slow.ws: gate, healthy.ws: healthy.service.LDAP}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- slow.service.run(ctx, 10*time.Millisecond) }()
	select {
	case <-gate.scanned:
	case <-time.After(2 * time.Second):
		t.Fatal("slow workspace not scheduled")
	}
	until := time.After(2 * time.Second)
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-until:
			cancel()
			<-done
			t.Fatal("slow workspace blocked healthy sync")
		case <-tick.C:
			c, err := healthy.service.Identity.DB.Q.GetWorkspaceIdentityDirectory(ctx, healthy.ws)
			if err != nil {
				cancel()
				<-done
				t.Fatal(err)
			}
			if c.LastSuccessAt != nil {
				cancel()
				if err := <-done; !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
				return
			}
		}
	}
}
