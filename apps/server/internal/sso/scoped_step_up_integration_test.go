//go:build integration

package sso

import (
	"context"
	"testing"
	"time"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
)

func scopedStepUpFixture(t *testing.T) (*serviceFixture, identitypolicy.Principal, sqlc.Session) {
	t.Helper()
	f := newServiceFixture(t)
	f.activate(t)
	ctx := t.Context()
	policy, err := f.s.DB.Q.GetIdentityPolicy(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.DB.Q.SetIdentityPolicy(ctx, sqlc.SetIdentityPolicyParams{WorkspaceID: f.ws, ExpectedVersion: policy.Version, Mode: "enforced", AssuranceMaxAgeSeconds: 3600}); err != nil {
		t.Fatal(err)
	}
	begin, err := f.s.Begin(ctx, identitypolicy.Principal{}, f.ws, &pb.SSOBeginRequest{Purpose: pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LOGIN, ClientKind: pb.SSOClientKind_SSO_CLIENT_KIND_WEB})
	if err != nil {
		t.Fatal(err)
	}
	// The old proof leaves only three minutes on the original absolute session.
	code, state := f.idp.code(t, begin.Response.AuthorizationUrl, "owner-subject", map[string]any{"auth_time": time.Now().Add(-57 * time.Minute).Unix()})
	cb, err := f.s.Callback(ctx, f.connection, state, begin.Browser, code)
	if err != nil {
		t.Fatal(err)
	}
	out, err := f.s.Finish(ctx, cb.FlowID, begin.Browser)
	if err != nil || out.Tokens == nil {
		t.Fatalf("scoped login failed: %v", err)
	}
	row, err := f.s.DB.Q.GetSession(ctx, mustUUID(t, out.Tokens.SessionId))
	if err != nil {
		t.Fatal(err)
	}
	p := identitypolicy.Principal{SessionID: row.ID, UserID: row.UserID, Authority: identitypolicy.WorkspaceSSO, WorkspaceID: f.ws, ConnectionID: f.connection, ExpiresAt: row.ExpiresAt, Version: row.AuthorityVersion}
	// A stale assurance must be repairable while the original session is still live.
	if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE session_workspace_assurances SET valid_until=clock_timestamp()-interval '1 second' WHERE session_id=$1`, row.ID); err != nil {
		t.Fatal(err)
	}
	return f, p, row
}

func beginScopedStepUp(t *testing.T, f *serviceFixture, p identitypolicy.Principal, native bool) (BeginResult, string) {
	t.Helper()
	req := &pb.SSOBeginRequest{Purpose: pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_STEP_UP, ClientKind: pb.SSOClientKind_SSO_CLIENT_KIND_WEB}
	verifier := ""
	if native {
		req.ClientKind = pb.SSOClientKind_SSO_CLIENT_KIND_DESKTOP
		var err error
		verifier, err = identitycrypto.Secret()
		if err != nil {
			t.Fatal(err)
		}
		req.DesktopChallenge, err = identitycrypto.S256(verifier)
		if err != nil {
			t.Fatal(err)
		}
	}
	begin, err := f.s.Begin(t.Context(), p, f.ws, req)
	if err != nil {
		t.Fatal(err)
	}
	if native {
		_, begin.Browser, begin.Response.AuthorizationUrl, err = f.s.BrowserStart(t.Context(), mustURL(begin.Response.BrowserStartUrl).Query().Get("handle"))
		if err != nil {
			t.Fatal(err)
		}
	}
	return begin, verifier
}

func scopedCallback(t *testing.T, f *serviceFixture, begin BeginResult, subject string) (CallbackResult, error) {
	t.Helper()
	code, state := f.idp.code(t, begin.Response.AuthorizationUrl, subject, nil)
	return f.s.Callback(t.Context(), f.connection, state, begin.Browser, code)
}

func TestSSOScopedStepUpPreservesSessionAndGrantDeadlines(t *testing.T) {
	for _, native := range []bool{false, true} {
		name := "web"
		if native {
			name = "native"
		}
		t.Run(name, func(t *testing.T) {
			f, p, original := scopedStepUpFixture(t)
			ctx := t.Context()
			client, consent, grant := uuid.New(), uuid.New(), uuid.New()
			fixtures := []struct {
				sql  string
				args []any
			}{
				{`INSERT INTO oauth_clients(id,workspace_id,client_id,name,client_type,auth_method) VALUES($1,$2,$3,'Fixture','public_native','none')`, []any{client, f.ws, client.String()}},
				{`INSERT INTO oauth_consents(id,workspace_id,user_id,client_id,scopes) VALUES($1,$2,$3,$4,ARRAY['openid'])`, []any{consent, f.ws, f.user, client}},
				{`INSERT INTO oauth_grants(id,workspace_id,user_id,client_id,consent_id,session_id,scopes,issuer,client_version,consent_version,policy_version,access_version,entitlement_version,session_version,authenticated_at,assurance_expires_at,expires_at,idle_expires_at) VALUES($1,$2,$3,$4,$5,$6,ARRAY['openid'],'https://sso.test',1,1,1,1,1,1,clock_timestamp()-interval '57 minutes',$7,clock_timestamp()+interval '2 minutes',clock_timestamp()+interval '1 minute')`, []any{grant, f.ws, f.user, client, consent, p.SessionID, original.ExpiresAt}},
			}
			for _, fixture := range fixtures {
				if _, err := f.s.DB.Pool.Exec(ctx, fixture.sql, fixture.args...); err != nil {
					t.Fatal(err)
				}
			}
			var before, after string
			grantSnapshot := func(target *string) {
				t.Helper()
				if err := f.s.DB.Pool.QueryRow(ctx, `SELECT row_to_json(g)::text FROM oauth_grants g WHERE id=$1`, grant).Scan(target); err != nil {
					t.Fatal(err)
				}
			}
			grantSnapshot(&before)
			begin, verifier := beginScopedStepUp(t, f, p, native)
			if begin.Response.ExpiresAt.AsTime().After(original.ExpiresAt) {
				t.Fatal("reauthentication flow exceeds original session deadline")
			}
			cb, err := scopedCallback(t, f, begin, "owner-subject")
			if err != nil {
				t.Fatal(err)
			}
			complete := func() (Result, error) {
				if native {
					return f.s.Exchange(ctx, cb.FlowID, cb.Ticket, verifier)
				}
				return f.s.Finish(ctx, cb.FlowID, begin.Browser)
			}
			out, err := complete()
			if err != nil || out.Tokens != nil || out.Tested || out.Assurance == nil || out.Assurance.ExpiresAt.AsTime().After(original.ExpiresAt) || time.Since(out.Assurance.AuthenticatedAt.AsTime()) > time.Minute {
				t.Fatalf("scoped step-up changed authority or deadline: %+v %v", out, err)
			}
			current, err := f.s.DB.Q.GetSession(ctx, p.SessionID)
			if err != nil || current.ID != original.ID || current.AuthorityKind != original.AuthorityKind || current.AuthorityVersion != original.AuthorityVersion || current.LocalAuthenticatedAt != nil || !current.ExpiresAt.Equal(original.ExpiresAt) || current.AuthorityWorkspaceID == nil || *current.AuthorityWorkspaceID != f.ws || current.AuthorityConnectionID == nil || *current.AuthorityConnectionID != f.connection {
				t.Fatalf("original scoped session changed: %+v %v", current, err)
			}
			var sessions int
			if err := f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id=$1`, f.user).Scan(&sessions); err != nil || sessions != 2 {
				t.Fatalf("step-up created a new session: %d %v", sessions, err)
			}
			grantSnapshot(&after)
			if before != after {
				t.Fatal("step-up renewed old OAuth grant authentication or deadline")
			}
			st, err := f.s.loader(f.s.DB.Q).LoadIdentityState(ctx, p.SessionID, f.user, f.ws)
			if err != nil || !identitypolicy.Evaluate(time.Now(), st, identitypolicy.WorkspaceRead).Allowed || identitypolicy.Evaluate(time.Now(), st, identitypolicy.GlobalRead).Allowed {
				t.Fatalf("step-up failed workspace access or expanded global authority: %v", err)
			}
			if _, err := complete(); err == nil {
				t.Fatal("scoped step-up replay accepted")
			}
		})
	}
}

func TestSSOScopedStepUpRejectsChangedBoundary(t *testing.T) {
	mutations := map[string]func(*testing.T, *serviceFixture, identitypolicy.Principal){
		"policy": func(t *testing.T, f *serviceFixture, _ identitypolicy.Principal) {
			scopedMutation(t, f, `UPDATE workspace_identity_policies SET version=version+1 WHERE workspace_id=$1`, f.ws)
		},
		"access": func(t *testing.T, f *serviceFixture, _ identitypolicy.Principal) {
			if _, err := f.s.DB.Q.TouchIdentityAccess(t.Context(), sqlc.TouchIdentityAccessParams{WorkspaceID: f.ws, UserID: f.user}); err != nil {
				t.Fatal(err)
			}
		},
		"entitlement": func(t *testing.T, f *serviceFixture, _ identitypolicy.Principal) {
			scopedMutation(t, f, `UPDATE workspace_identity_grants SET enabled=false WHERE workspace_id=$1 AND feature='corporate_sso'`, f.ws)
		},
		"connection": func(t *testing.T, f *serviceFixture, _ identitypolicy.Principal) {
			scopedMutation(t, f, `UPDATE workspace_identity_connections SET version=version+1 WHERE id=$1`, f.connection)
		},
		"identity_version": func(t *testing.T, f *serviceFixture, _ identitypolicy.Principal) {
			scopedMutation(t, f, `UPDATE workspace_external_identities SET version=version+1 WHERE workspace_id=$1`, f.ws)
		},
		"identity_subject": func(t *testing.T, f *serviceFixture, _ identitypolicy.Principal) {
			scopedMutation(t, f, `UPDATE workspace_external_identities SET subject='changed-subject' WHERE workspace_id=$1`, f.ws)
		},
		"identity_revoked": func(t *testing.T, f *serviceFixture, _ identitypolicy.Principal) {
			scopedMutation(t, f, `UPDATE workspace_external_identities SET status='unlinked' WHERE workspace_id=$1`, f.ws)
		},
		"session_version": func(t *testing.T, f *serviceFixture, p identitypolicy.Principal) {
			scopedMutation(t, f, `UPDATE sessions SET authority_version=authority_version+1 WHERE id=$1`, p.SessionID)
		},
		"session_revoked": func(t *testing.T, f *serviceFixture, p identitypolicy.Principal) {
			scopedMutation(t, f, `UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1`, p.SessionID)
		},
		"session_deadline": func(t *testing.T, f *serviceFixture, p identitypolicy.Principal) {
			scopedMutation(t, f, `UPDATE sessions SET expires_at=expires_at+interval '1 hour' WHERE id=$1`, p.SessionID)
		},
		"session_expired": func(_ *testing.T, f *serviceFixture, _ identitypolicy.Principal) {
			f.s.Now = func() time.Time { return time.Now().Add(4 * time.Minute) }
		},
		"member_removed": func(t *testing.T, f *serviceFixture, _ identitypolicy.Principal) {
			scopedMutation(t, f, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, f.ws, f.user)
		},
		"directory_disabled": func(t *testing.T, f *serviceFixture, _ identitypolicy.Principal) {
			directory := uuid.New()
			scopedMutation(t, f, `INSERT INTO workspace_directories(id,workspace_id,name,url,host,bind_dn,bind_secret_box,base_dn,last_success_at) VALUES($1,$2,'Fixture','ldaps://directory.test','directory.test','fixture',$3,'fixture',clock_timestamp())`, directory, f.ws, []byte("fixture"))
			scopedMutation(t, f, `INSERT INTO directory_objects(workspace_id,directory_id,object_guid,user_id,distinguished_name,status) VALUES($1,$2,$3,$4,'fixture','disabled')`, f.ws, directory, uuid.New(), f.user)
		},
	}
	for _, phase := range []string{"callback", "finish"} {
		for name, mutate := range mutations {
			t.Run(phase+"/"+name, func(t *testing.T) {
				f, p, _ := scopedStepUpFixture(t)
				begin, _ := beginScopedStepUp(t, f, p, false)
				var cb CallbackResult
				if phase == "finish" {
					var err error
					cb, err = scopedCallback(t, f, begin, "owner-subject")
					if err != nil {
						t.Fatal(err)
					}
				}
				mutate(t, f, p)
				if phase == "callback" {
					if _, err := scopedCallback(t, f, begin, "owner-subject"); err == nil {
						t.Fatal("changed scoped binding accepted callback")
					}
				} else if _, err := f.s.Finish(t.Context(), cb.FlowID, begin.Browser); err == nil {
					t.Fatal("changed scoped binding accepted finish")
				}
			})
		}
	}
}

func scopedMutation(t *testing.T, f *serviceFixture, query string, args ...any) {
	t.Helper()
	if _, err := f.s.DB.Pool.Exec(t.Context(), query, args...); err != nil {
		t.Fatal(err)
	}
}

func TestSSOScopedStepUpRejectsOtherSubjectAndAuthority(t *testing.T) {
	for _, name := range []string{"subject", "workspace", "recovery", "guest", "bot", "revoked", "expired"} {
		t.Run(name, func(t *testing.T) {
			f, p, original := scopedStepUpFixture(t)
			if name == "subject" {
				begin, _ := beginScopedStepUp(t, f, p, false)
				if _, err := scopedCallback(t, f, begin, "other-subject"); err == nil {
					t.Fatal("changed subject accepted")
				}
				return
			}
			ws := f.ws
			switch name {
			case "workspace":
				ws = uuid.New()
				scopedMutation(t, f, `INSERT INTO workspaces(id,slug,name,owner_id) VALUES($1,$2,'Other',$3)`, ws, "other-"+ws.String()[:12], f.user)
				scopedMutation(t, f, `INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, ws, f.user)
				t.Cleanup(func() { _, _ = f.s.DB.Pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id=$1`, ws) })
				// Give B a valid active connection and grant so denial proves the scope check.
				scopedMutation(t, f, `INSERT INTO workspace_identity_connections(workspace_id,name,provider,issuer,client_id,status,tested_version,tested_at) VALUES($1,'Other','generic',$2,'fixture-client','active',1,clock_timestamp())`, ws, f.idp.server.URL)
				if _, err := f.s.DB.Q.UpsertIdentityGrant(t.Context(), sqlc.UpsertIdentityGrantParams{WorkspaceID: ws, Feature: "corporate_sso", Source: "cloud_business", Enabled: true}); err != nil {
					t.Fatal(err)
				}
				scopedMutation(t, f, `INSERT INTO workspace_plans(workspace_id,plan) VALUES($1,'enterprise') ON CONFLICT(workspace_id) DO UPDATE SET plan='enterprise'`, ws)
			case "recovery":
				row, err := f.s.DB.Q.CreateScopedIdentitySession(t.Context(), sqlc.CreateScopedIdentitySessionParams{UserID: f.user, RefreshTokenHash: identitycrypto.Hash(uuid.NewString()), ExpiresAt: original.ExpiresAt, AuthorityKind: "recovery", AuthorityWorkspaceID: &f.ws, RecoveryAuthenticatedAt: &original.CreatedAt})
				if err != nil {
					t.Fatal(err)
				}
				p.SessionID = row.ID
			case "guest":
				scopedMutation(t, f, `UPDATE users SET is_guest=true,guest_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, f.user)
			case "bot":
				scopedMutation(t, f, `UPDATE users SET is_bot=true WHERE id=$1`, f.user)
			case "revoked":
				scopedMutation(t, f, `UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1`, p.SessionID)
			case "expired":
				f.s.Now = func() time.Time { return time.Now().Add(4 * time.Minute) }
			}
			if _, err := f.s.Begin(t.Context(), p, ws, &pb.SSOBeginRequest{Purpose: pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_STEP_UP, ClientKind: pb.SSOClientKind_SSO_CLIENT_KIND_WEB}); err == nil {
				t.Fatal("invalid scoped authority began step-up")
			}
		})
	}
}
