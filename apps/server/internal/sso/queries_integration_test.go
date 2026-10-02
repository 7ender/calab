//go:build integration

package sso

import (
	"context"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/google/uuid"
)

func TestSharedIdentityQueries(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	var err error
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := d.Q.WithTx(tx)
	user, ws, session, client, consent, grant := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	fixtures := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,display_name)VALUES($1,$2,'Fixture')`, []any{user, user.String() + "@sso.test"}},
		{`INSERT INTO workspaces(id,slug,name,owner_id)VALUES($1,$2,'Fixture',$3)`, []any{ws, "sso-" + ws.String()[:12], user}},
		{`INSERT INTO workspace_members(workspace_id,user_id,role)VALUES($1,$2,'owner')`, []any{ws, user}},
		{`INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at)VALUES($1,$2,$3,now()+interval '1 hour')`, []any{session, user, []byte("fixture")}},
		{`INSERT INTO oauth_clients(id,workspace_id,client_id,name,client_type,auth_method)VALUES($1,$2,$3,'Fixture','public_native','none')`, []any{client, ws, client.String()}},
		{`INSERT INTO oauth_consents(id,workspace_id,user_id,client_id,scopes)VALUES($1,$2,$3,$4,ARRAY['openid','profile','email'])`, []any{consent, ws, user, client}},
		{`INSERT INTO oauth_grants(id,workspace_id,user_id,client_id,consent_id,session_id,scopes,issuer,client_version,consent_version,policy_version,access_version,entitlement_version,session_version,authenticated_at,expires_at,idle_expires_at)VALUES($1,$2,$3,$4,$5,$6,ARRAY['openid','profile','email'],'https://fixture.test',1,1,1,1,1,1,now(),now()+interval '1 hour',now()+interval '30 minutes')`, []any{grant, ws, user, client, consent, session}},
	}
	for _, f := range fixtures {
		if _, err = tx.Exec(ctx, f.sql, f.args...); err != nil {
			t.Fatal(err)
		}
	}
	narrowed, err := q.NarrowOAuthGrantScopes(ctx, sqlc.NarrowOAuthGrantScopesParams{WorkspaceID: ws, ID: grant, ClientID: client, Scopes: []string{"openid", "profile"}})
	if err != nil || len(narrowed.Scopes) != 2 {
		t.Fatalf("narrow: %v %+v", err, narrowed)
	}
	for _, scopes := range [][]string{{"openid", "email"}, {"profile"}, {"openid", "bogus"}} {
		if _, err = q.NarrowOAuthGrantScopes(ctx, sqlc.NarrowOAuthGrantScopesParams{WorkspaceID: ws, ID: grant, ClientID: client, Scopes: scopes}); !db.IsNotFound(err) {
			t.Fatalf("invalid narrowing accepted: %v", err)
		}
	}
	if _, err = q.LockIdentityBoundary(ctx, sqlc.LockIdentityBoundaryParams{WorkspaceID: ws, UserID: user, SessionID: session}); err != nil {
		t.Fatal(err)
	}
	if _, err = q.LockIdentityBoundary(ctx, sqlc.LockIdentityBoundaryParams{WorkspaceID: ws, UserID: user, SessionID: uuid.New()}); !db.IsNotFound(err) {
		t.Fatal("foreign boundary accepted")
	}
	if _, err = tx.Exec(ctx, `UPDATE oauth_grants SET idle_expires_at=$2 WHERE id=$1`, grant, time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err = q.NarrowOAuthGrantScopes(ctx, sqlc.NarrowOAuthGrantScopesParams{WorkspaceID: ws, ID: grant, ClientID: client, Scopes: []string{"openid"}}); !db.IsNotFound(err) {
		t.Fatal("expired grant accepted")
	}
	if _, err = tx.Exec(ctx, `UPDATE oauth_grants SET idle_expires_at=now()+interval '30 minutes',revoked_at=now() WHERE id=$1`, grant); err != nil {
		t.Fatal(err)
	}
	if _, err = q.NarrowOAuthGrantScopes(ctx, sqlc.NarrowOAuthGrantScopesParams{WorkspaceID: ws, ID: grant, ClientID: client, Scopes: []string{"openid"}}); !db.IsNotFound(err) {
		t.Fatal("revoked grant accepted")
	}
}
