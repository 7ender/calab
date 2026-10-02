//go:build integration

package oauthprovider

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"google.golang.org/protobuf/encoding/protojson"
)

// The boundary lock serializes with writers of the member/session rows but no
// longer blocks FK (KEY SHARE) inserts referencing the workspace or user.
func TestProviderBoundaryLockAllowsForeignKeyInserts(t *testing.T) {
	f := fixture(t)
	ctx := context.Background()
	tx, err := f.d.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = f.d.Q.WithTx(tx).LockIdentityBoundary(ctx, sqlc.LockIdentityBoundaryParams{WorkspaceID: f.ws, UserID: f.user, SessionID: f.session}); err != nil {
		t.Fatal(err)
	}
	other := uuid.New()
	f.sql("INSERT INTO users(id,display_name,email) VALUES($1,'Bob','bob@example.test')", other)
	conn, err := f.d.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err = conn.Exec(ctx, "SET lock_timeout = '2s'"); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", f.ws, other); err != nil {
		t.Fatalf("FK insert blocked by the boundary lock: %v", err)
	}
	_, err = conn.Exec(ctx, "UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", f.ws, f.user)
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != "55P03" {
		t.Fatalf("member update must wait for the boundary lock: %v", err)
	}
	_, err = conn.Exec(ctx, "UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1", f.session)
	if !errors.As(err, &pg) || pg.Code != "55P03" {
		t.Fatalf("session revoke must wait for the boundary lock: %v", err)
	}
}

// A rename between bind and decide is refused; a rebind shows the new name and
// the consent stores exactly the name the user saw.
func TestProviderRenameBetweenBindAndDecide(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	req := f.bindRequest(f.begin(c.Client, nil))
	rename := &v1.UpdateOAuthClientRequest{Version: c.Client.Version, Name: "Renamed RP", RedirectUris: c.Client.RedirectUris, Scopes: c.Client.Scopes, RefreshEnabled: c.Client.RefreshEnabled}
	if st, _, b := f.proto("PATCH", "/api/workspaces/"+f.ws.String()+"/oauth/clients/"+c.Client.Id, rename); st != 200 {
		t.Fatalf("rename %d %s", st, b)
	}
	decisionPath := "/api/oauth/requests/" + req.handle + "/decision"
	if st, _, b := f.proto("POST", decisionPath, &v1.DecideOAuthRequest{Allow: true, CsrfToken: req.csrf}); st != 409 {
		t.Fatalf("decide after rename %d %s", st, b)
	}
	st, _, b := f.proto("POST", "/api/oauth/requests/"+req.handle+"/bind", &v1.BindOAuthRequest{CsrfToken: req.handle})
	snapshot := &v1.OAuthConsentSnapshot{}
	if st != 200 || protojson.Unmarshal(b, snapshot) != nil || snapshot.ClientName != "Renamed RP" {
		t.Fatalf("rebind %d %s", st, b)
	}
	req.csrf = snapshot.CsrfToken
	if code := f.decision(req, true, false); code == "" {
		t.Fatal("no code after rebind")
	}
	var name string
	if err := f.d.Pool.QueryRow(context.Background(), "SELECT client_name FROM oauth_consents WHERE workspace_id=$1 AND user_id=$2", f.ws, f.user).Scan(&name); err != nil || name != "Renamed RP" {
		t.Fatalf("consent name %q %v", name, err)
	}
}

func TestProviderPendingRequestCaps(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, false)
	ctx := context.Background()
	pending := func() int {
		var n int
		if err := f.d.Pool.QueryRow(ctx, "SELECT count(*) FROM oauth_authorization_requests WHERE workspace_id=$1 AND consumed_at IS NULL", f.ws).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// Per browser: bindings pushed out of the cookie are deleted.
	for range requestCookieMax + 2 {
		_ = f.begin(c.Client, nil)
	}
	if n := pending(); n != requestCookieMax {
		t.Fatalf("pending per browser %d", n)
	}
	// Per IP: fill the bucket of this client IP up to the cap (copies of a live row).
	f.sql(`INSERT INTO oauth_authorization_requests (workspace_id,client_id,issuer,client_version,handle_hash,browser_hash,redirect_uri,scopes,state,nonce,pkce_challenge,expires_at,client_ip_hash)
SELECT workspace_id,client_id,issuer,client_version,sha256(handle_hash||int4send(i)),sha256(browser_hash||int4send(i)),redirect_uri,scopes,state,nonce,pkce_challenge,expires_at,client_ip_hash
FROM (SELECT * FROM oauth_authorization_requests WHERE workspace_id=$1 LIMIT 1) r, generate_series(1,$2::int) i`, f.ws, pendingRequestsPerIP-requestCookieMax)
	f.http.Jar, _ = cookiejar.New(nil) // a fresh browser on the same IP
	q := url.Values{"response_type": {"code"}, "client_id": {c.Client.ClientId}, "redirect_uri": {c.Client.RedirectUris[0]}, "scope": {"openid"}, "state": {"s"}, "nonce": {"n"}, "code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(hash("verifier"))}}
	st, h, b := f.wire("GET", "/oidc/workspaces/"+f.ws.String()+"/authorize?"+q.Encode(), "", nil, "", "")
	if st != 303 || !strings.Contains(h.Get("Location"), "error=temporarily_unavailable") || !strings.HasPrefix(h.Get("Location"), c.Client.RedirectUris[0]) {
		t.Fatalf("per-IP cap %d %s %s", st, h.Get("Location"), b)
	}
	if n := pending(); n != pendingRequestsPerIP {
		t.Fatalf("pending after refusal %d", n)
	}
	f.sql("UPDATE oauth_authorization_requests SET expires_at=clock_timestamp() WHERE workspace_id=$1", f.ws)
	_ = f.begin(c.Client, nil)
}

// Re-consent replaces this device's family only; a narrowing decision closes all.
func TestProviderReconsentKeepsOtherDevices(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	first, second := f.session, uuid.New()
	f.sql("INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at,local_authenticated_at) VALUES($1,$2,$3,clock_timestamp()+interval '8 hours',clock_timestamp())", second, f.user, hash("second device"))
	flow := func(session uuid.UUID, scope string) tokenResponse {
		t.Helper()
		f.session = session
		defer func() { f.session = first }()
		req := f.bindRequest(f.begin(c.Client, url.Values{"scope": {scope}}))
		st, tokens, b := f.exchange(c, req, f.decision(req, true, false))
		if st != 200 {
			t.Fatalf("exchange %d %s", st, b)
		}
		return tokens
	}
	alive := func(name string, tokens tokenResponse, want int) {
		t.Helper()
		if st, _ := f.info(tokens.AccessToken); st != want {
			t.Fatalf("%s: userinfo %d, want %d", name, st, want)
		}
	}
	one := flow(first, "openid")
	two := flow(second, "openid profile") // widening: device one keeps its grant
	alive("device one after widening", one, 200)
	again := flow(second, "openid profile") // same decision replaces device two only
	alive("device two replaced", two, 401)
	alive("device one after re-consent elsewhere", one, 200)
	alive("device two new grant", again, 200)
	var reason string
	if err := f.d.Pool.QueryRow(context.Background(), "SELECT revoked_reason FROM oauth_grants g JOIN oauth_tokens t ON t.grant_id=g.id WHERE t.token_hash=$1", hash(two.AccessToken)).Scan(&reason); err != nil || reason != "consent_replaced" {
		t.Fatalf("replaced reason %q %v", reason, err)
	}
	narrowed := flow(second, "openid") // narrowing bumps the consent version
	alive("device one after narrowing", one, 401)
	alive("device two before narrowing", again, 401)
	alive("narrowed grant", narrowed, 200)
}

// Management reads create no policy row; OAuth-only changes publish no identity
// invalidation (gateway/RTC never accept provider tokens).
func TestProviderManagementReadAndOAuthOnlyChangesWriteNothing(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	ctx := context.Background()
	f.sql("DELETE FROM workspace_identity_policies WHERE workspace_id=$1", f.ws)
	for _, path := range []string{"/api/workspaces/" + f.ws.String() + "/oauth/clients", "/api/workspaces/" + f.ws.String() + "/oauth/clients/" + c.Client.Id} {
		if st, _, b := f.proto("GET", path, nil); st != 200 {
			t.Fatalf("GET %s %d %s", path, st, b)
		}
	}
	var policies int
	if err := f.d.Pool.QueryRow(ctx, "SELECT count(*) FROM workspace_identity_policies WHERE workspace_id=$1", f.ws).Scan(&policies); err != nil || policies != 0 {
		t.Fatalf("management GET wrote the policy: %d %v", policies, err)
	}
	f.sql("DELETE FROM identity_invalidation_outbox WHERE workspace_id=$1", f.ws)
	// Token revocation, a failed grant check, user withdrawal and client disable.
	req, code := f.code(c.Client, true)
	st, tokens, b := f.exchange(c, req, code)
	if st != 200 {
		t.Fatalf("exchange %d %s", st, b)
	}
	revoke := url.Values{"client_id": {c.Client.ClientId}, "token": {tokens.RefreshToken}}
	if st, _, b := f.wire("POST", "/oidc/workspaces/"+f.ws.String()+"/revoke", "application/x-www-form-urlencoded", []byte(revoke.Encode()), "", ""); st != 200 {
		t.Fatalf("revoke %d %s", st, b)
	}
	req, code = f.code(c.Client, true)
	if st, _, b := f.exchange(c, req, code); st != 200 {
		t.Fatalf("exchange %d %s", st, b)
	}
	var grant uuid.UUID
	if err := f.d.Pool.QueryRow(ctx, "SELECT id FROM oauth_grants WHERE workspace_id=$1 AND revoked_at IS NULL", f.ws).Scan(&grant); err != nil {
		t.Fatal(err)
	}
	if st, _, b := f.proto("DELETE", "/api/me/oauth-grants/"+grant.String(), nil); st != 204 {
		t.Fatalf("withdraw %d %s", st, b)
	}
	if st, _, b := f.proto("DELETE", "/api/workspaces/"+f.ws.String()+"/oauth/clients/"+c.Client.Id, nil); st != 204 {
		t.Fatalf("disable %d %s", st, b)
	}
	var outbox, audit int
	if err := f.d.Pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM identity_invalidation_outbox WHERE workspace_id=$1),(SELECT count(*) FROM workspace_identity_audit WHERE workspace_id=$1 AND action IN ('oauth_revoke','user_consent_revoked','oauth_client_disabled'))", f.ws).Scan(&outbox, &audit); err != nil {
		t.Fatal(err)
	}
	if outbox != 0 || audit != 3 {
		t.Fatalf("outbox %d (want 0), audit %d (want 3)", outbox, audit)
	}
}
