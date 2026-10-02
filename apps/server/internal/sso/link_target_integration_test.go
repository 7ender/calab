//go:build integration

package sso

import (
	"context"
	"testing"
	"time"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
)

// A draft revision being prepared must not capture member links: link targets the active
// connection; only an owner already linked to it links ahead to the draft, and test uses
// the draft.
func TestSSOLinkTargetsActiveWhileDraftExists(t *testing.T) {
	f := newServiceFixture(t)
	f.activate(t)
	ctx := context.Background()
	member, session := uuid.New(), uuid.New()
	now := time.Now()
	for _, v := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,display_name,password_hash)VALUES($1,$2,'Member','fixture')`, []any{member, member.String() + "@sso.test"}},
		{`INSERT INTO workspace_members(workspace_id,user_id,role)VALUES($1,$2,'member')`, []any{f.ws, member}},
		{`INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at,local_authenticated_at)VALUES($1,$2,$3,$4,$5)`, []any{session, member, identitycrypto.Hash(uuid.NewString()), now.Add(time.Hour), now}},
	} {
		if _, err := f.s.DB.Pool.Exec(ctx, v.sql, v.args...); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { _, _ = f.s.DB.Pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, member) })
	secret := "draft-secret"
	draft, err := f.s.PutConnection(ctx, f.p, f.ws, &pb.PutIdentityConnectionRequest{Version: 1, Name: "Replacement", Provider: pb.IdentityProvider_IDENTITY_PROVIDER_GENERIC, Issuer: f.idp.server.URL, ClientId: "fixture-client-2", ClientSecret: &secret})
	if err != nil {
		t.Fatal(err)
	}
	if draft.Id == f.connection.String() {
		t.Fatal("client id change must create a new draft")
	}
	target := func(p identitypolicy.Principal, purpose pb.SSOFlowPurpose) string {
		t.Helper()
		begin, err := f.s.Begin(ctx, p, f.ws, &pb.SSOBeginRequest{Purpose: purpose, ClientKind: pb.SSOClientKind_SSO_CLIENT_KIND_WEB})
		if err != nil {
			t.Fatal(err)
		}
		flow := uuid.MustParse(begin.Response.FlowId)
		tx, err := f.s.DB.Q.GetIdentityLoginTransactionByID(ctx, flow)
		if err != nil {
			t.Fatal(err)
		}
		return tx.ConnectionID.String()
	}
	mp := identitypolicy.Principal{SessionID: session, UserID: member, Authority: identitypolicy.LocalAccount, LocalAuthenticatedAt: now, ExpiresAt: now.Add(time.Hour), Version: 1}
	if got := target(mp, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LINK); got != f.connection.String() {
		t.Fatalf("member link went to %s, want the active connection", got)
	}
	if got := target(f.p, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LINK); got != draft.Id {
		t.Fatalf("linked owner's link went to %s, want the draft", got)
	}
	if got := target(f.p, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_TEST); got != draft.Id {
		t.Fatalf("test went to %s, want the draft", got)
	}
}
