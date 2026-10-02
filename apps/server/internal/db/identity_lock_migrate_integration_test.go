//go:build integration

package db

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// Rolling deploy: a long transaction on sessions/workspaces must make 00055/00057 fail within
// lock_timeout instead of queueing an ACCESS EXCLUSIVE request that blocks every login. After
// the holder ends, the same migration applies and its NOT VALID checks still guard new rows.
func TestIdentityMigrationsFailFastOnLocks(t *testing.T) {
	d := identityTestDB(t) // at 00054
	ctx := context.Background()
	user, ws := uuid.New(), uuid.New()
	mustIdentitySQL(t, d, `INSERT INTO users(id,email,display_name) VALUES($1,$2,'Legacy')`, user, user.String()+"@lock.test")
	mustIdentitySQL(t, d, `INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at) VALUES($1,$2,'\x01',now()+interval '1 day')`, uuid.New(), user)
	blocked := func(table, mode string, version int64) {
		t.Helper()
		holder, err := d.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = holder.Rollback(ctx) }()
		if _, err = holder.Exec(ctx, "LOCK TABLE "+table+" IN "+mode+" MODE"); err != nil {
			t.Fatal(err)
		}
		mctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		start := time.Now()
		err = d.MigrateTo(mctx, version)
		var pg *pgconn.PgError
		if err == nil || !errors.As(err, &pg) || pg.Code != "55P03" || time.Since(start) > 20*time.Second {
			t.Fatalf("migration %d behind a %s lock on %s: %v after %s, want lock_timeout", version, mode, table, err, time.Since(start))
		}
	}
	blocked("sessions", "ACCESS SHARE", 55)
	if err := d.MigrateTo(ctx, 56); err != nil {
		t.Fatal(err)
	}
	blocked("workspaces", "ROW EXCLUSIVE", 57)
	if err := d.MigrateTo(ctx, 57); err != nil {
		t.Fatal(err)
	}
	mustIdentitySQL(t, d, `INSERT INTO workspaces(id,slug,name,owner_id) VALUES($1,$2,'Lock',$3)`, ws, "lock-"+ws.String()[:8], user)
	for _, bad := range []string{
		`INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at,authority_kind) VALUES(gen_random_uuid(),$1,'\x02',now()+interval '1 day','bogus')`,
		`INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at,authority_version) VALUES(gen_random_uuid(),$1,'\x02',now()+interval '1 day',0)`,
		`INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at,authority_kind) VALUES(gen_random_uuid(),$1,'\x02',now()+interval '1 day','workspace_sso')`,
		`INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at,authority_kind,authority_workspace_id,recovery_authenticated_at) VALUES(gen_random_uuid(),$1,'\x02',now()+interval '1 day','recovery',gen_random_uuid(),now())`,
	} {
		if _, err := d.Pool.Exec(ctx, bad, user); err == nil {
			t.Fatalf("NOT VALID constraint did not guard a new row: %s", bad)
		}
	}
}
