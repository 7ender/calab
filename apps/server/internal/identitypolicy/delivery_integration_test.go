//go:build integration

package identitypolicy_test

import (
	"context"
	"os"
	"testing"

	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

// Off/optional delivery to a directory-managed member requires the directory_sync
// entitlement like Evaluate, not only a fresh scan.
func TestDeliveryDirectoryMemberNeedsEntitlement(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	user, ws, dir := uuid.New(), uuid.New(), uuid.New()
	for _, v := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,display_name)VALUES($1,$2,'Member')`, []any{user, user.String() + "@delivery.test"}},
		{`INSERT INTO workspaces(id,slug,name,owner_id)VALUES($1,$2,'Delivery',$3)`, []any{ws, "del-" + ws.String()[:12], user}},
		{`INSERT INTO workspace_members(workspace_id,user_id,role)VALUES($1,$2,'member')`, []any{ws, user}},
		{`INSERT INTO workspace_plans(workspace_id,plan)VALUES($1,'enterprise') ON CONFLICT(workspace_id) DO UPDATE SET plan='enterprise'`, []any{ws}},
		{`INSERT INTO workspace_directories(id,workspace_id,name,host,url,base_dn,bind_dn,bind_secret_box,last_success_at)VALUES($1,$2,'AD','dc.test','ldaps://dc.test','DC=test','CN=svc,DC=test','\x00',now())`, []any{dir, ws}},
		{`INSERT INTO directory_objects(workspace_id,directory_id,object_guid,user_id,distinguished_name,status)VALUES($1,$2,$3,$4,'CN=Member,DC=test','active')`, []any{ws, dir, uuid.New(), user}},
	} {
		if _, err := d.Pool.Exec(ctx, v.sql, v.args...); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = d.Pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id=$1`, ws)
		_, _ = d.Pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, user)
	})
	delivery := &identitypolicy.Delivery{Loader: identitypolicy.NewSQLLoader(d.Q, identitypolicy.EntitlementConfig{Edition: "cloud"})}
	check := func() identitypolicy.Decision {
		t.Helper()
		dec, err := delivery.Check(ctx, user, ws)
		if err != nil {
			t.Fatal(err)
		}
		return dec
	}
	if dec := check(); dec.Allowed || dec.Reason != identitypolicy.EntitlementRequired {
		t.Fatalf("no directory_sync grant: %+v", dec)
	}
	if _, err := d.Q.UpsertIdentityGrant(ctx, sqlc.UpsertIdentityGrantParams{WorkspaceID: ws, Feature: "directory_sync", Source: "cloud_business", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if dec := check(); !dec.Allowed {
		t.Fatalf("granted, fresh, active: %+v", dec)
	}
	if _, err := d.Pool.Exec(ctx, `UPDATE workspace_identity_grants SET revoked_at=now() WHERE workspace_id=$1 AND feature='directory_sync'`, ws); err != nil {
		t.Fatal(err)
	}
	if dec := check(); dec.Allowed || dec.Reason != identitypolicy.EntitlementRequired {
		t.Fatalf("revoked grant still delivers: %+v", dec)
	}
}
