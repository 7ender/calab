//go:build integration

package oauthprovider

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// holdWorkspaceRow keeps an exclusive FOR UPDATE row lock (as a concurrent
// workspace delete would) until the returned release is called.
func holdWorkspaceRow(t *testing.T, f *providerFixture, ws uuid.UUID) func() {
	t.Helper()
	ctx := context.Background()
	tx, err := f.d.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", ws); err != nil {
		t.Fatal(err)
	}
	return func() { _ = tx.Rollback(ctx) }
}

// Anonymous protocol traffic never locks the workspace row or writes the policy.
func TestProviderUnauthenticatedRequestsTakeNoWorkspaceLock(t *testing.T) {
	f := fixture(t)
	public := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	confidential := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, false)
	f.sql("DELETE FROM workspace_identity_policies WHERE workspace_id=$1", f.ws)
	f.http.Timeout = 3 * time.Second
	base := "/oidc/workspaces/" + f.ws.String()
	release := holdWorkspaceRow(t, f, f.ws)
	randomAccess := opaque("calab_oa_")
	if st, _, b := f.wire("GET", base+"/userinfo", "", nil, "Bearer "+randomAccess, ""); st != 401 {
		t.Fatalf("random bearer %d %s", st, b)
	}
	badSecret := &v1.OAuthClientSecretResponse{Client: confidential.Client, SecretOnce: opaque("calab_os_")}
	if st, _, b := f.token(badSecret, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {opaque("calab_or_")}}); st != 401 {
		t.Fatalf("bad secret %d %s", st, b)
	}
	if st, _, b := f.token(public, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {opaque("calab_or_")}}); st != 400 || !strings.Contains(string(b), "invalid_grant") {
		t.Fatalf("unknown refresh %d %s", st, b)
	}
	if st, _, b := f.token(public, url.Values{"grant_type": {"authorization_code"}, "code": {opaque("calab_oc_")}, "redirect_uri": {public.Client.RedirectUris[0]}, "code_verifier": {strings.Repeat("v", 43)}}); st != 400 || !strings.Contains(string(b), "invalid_grant") {
		t.Fatalf("unknown code %d %s", st, b)
	}
	revoke := url.Values{"client_id": {public.Client.ClientId}, "token": {opaque("calab_oa_")}}
	if st, _, b := f.wire("POST", base+"/revoke", "application/x-www-form-urlencoded", []byte(revoke.Encode()), "", ""); st != 200 {
		t.Fatalf("unknown token revoke %d %s", st, b)
	}
	_ = f.begin(public.Client, nil) // anonymous authorize stores a request without locks
	release()

	// A whole authenticated flow reads the defaulted policy without creating it.
	req, code := f.code(public.Client, true)
	st, tokens, b := f.exchange(public, req, code)
	if st != 200 {
		t.Fatalf("exchange %d %s", st, b)
	}
	if st, _ := f.info(tokens.AccessToken); st != 200 {
		t.Fatal("userinfo after exchange")
	}
	var policies int
	if err := f.d.Pool.QueryRow(context.Background(), "SELECT count(*) FROM workspace_identity_policies WHERE workspace_id=$1", f.ws).Scan(&policies); err != nil {
		t.Fatal(err)
	}
	if policies != 0 {
		t.Fatal("protocol read path wrote the identity policy")
	}

	// The provider lock no longer blocks FK key-share inserts into the workspace.
	ctx := context.Background()
	err := f.d.Tx(ctx, func(q *sqlc.Queries) error {
		if err := f.s.lockWorkspace(ctx, q, f.ws); err != nil {
			return err
		}
		other := uuid.New()
		f.sql("INSERT INTO users(id,display_name,email) VALUES($1,'Bob',$2)", other, other.String()+"@example.test")
		insertCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		_, err := f.d.Pool.Exec(insertCtx, "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", f.ws, other)
		return err
	})
	if err != nil {
		t.Fatalf("member insert blocked by provider workspace lock: %v", err)
	}

	// Unknown workspaces answer 4xx, never a dependency 503.
	missing := "/oidc/workspaces/" + uuid.NewString()
	if st, _, _ := f.wire("GET", missing+"/userinfo", "", nil, "Bearer "+randomAccess, ""); st != 401 {
		t.Fatalf("missing workspace userinfo %d", st)
	}
	form := url.Values{"client_id": {public.Client.ClientId}, "grant_type": {"refresh_token"}, "refresh_token": {opaque("calab_or_")}}
	if st, _, _ := f.wire("POST", missing+"/token", "application/x-www-form-urlencoded", []byte(form.Encode()), "", ""); st != 401 {
		t.Fatalf("missing workspace token %d", st)
	}
	if st, _, _ := f.wire("POST", missing+"/revoke", "application/x-www-form-urlencoded", []byte(revoke.Encode()), "", ""); st != 401 {
		t.Fatalf("missing workspace revoke %d", st)
	}
}

type quotaCall struct {
	endpoint           string
	ws, client, userID uuid.UUID
}

// Client quotas are charged only after the client and its code/token checked out.
func TestProviderClientQuotaChargedOnlyAfterAuthentication(t *testing.T) {
	f := fixture(t)
	var mu sync.Mutex
	var calls []quotaCall
	var deny bool
	recorded := func() []quotaCall {
		mu.Lock()
		defer mu.Unlock()
		return append([]quotaCall(nil), calls...)
	}
	setDeny := func(v bool) {
		mu.Lock()
		defer mu.Unlock()
		deny = v
	}
	f.s.c.Quota = func(_ context.Context, endpoint string, ws, client, user uuid.UUID) error {
		mu.Lock()
		defer mu.Unlock()
		calls = append(calls, quotaCall{endpoint, ws, client, user})
		if deny {
			e := httpx.RateLimited()
			e.RetryAfter = 7 * time.Second
			return e
		}
		return nil
	}
	public := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	confidential := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, false)
	badSecret := &v1.OAuthClientSecretResponse{Client: confidential.Client, SecretOnce: opaque("calab_os_")}
	for range 5 {
		_, _, _ = f.token(public, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {opaque("calab_or_")}})
		_, _, _ = f.token(public, url.Values{"grant_type": {"authorization_code"}, "code": {opaque("calab_oc_")}, "redirect_uri": {public.Client.RedirectUris[0]}, "code_verifier": {strings.Repeat("v", 43)}})
		_, _, _ = f.token(badSecret, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {opaque("calab_or_")}})
		_, _, _ = f.wire("GET", "/oidc/workspaces/"+f.ws.String()+"/userinfo", "", nil, "Bearer "+opaque("calab_oa_"), "")
	}
	if got := recorded(); len(got) != 0 {
		t.Fatalf("unauthenticated traffic charged client quota: %v", got)
	}
	req, code := f.code(public.Client, true)
	clientID := uuid.MustParse(public.Client.Id)
	setDeny(true)
	form := url.Values{"client_id": {public.Client.ClientId}, "grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {req.redirect}, "code_verifier": {req.verifier}}
	st, h, b := f.wire("POST", "/oidc/workspaces/"+f.ws.String()+"/token", "application/x-www-form-urlencoded", []byte(form.Encode()), "", "")
	if st != 429 || !strings.Contains(string(b), "temporarily_unavailable") || h.Get("Retry-After") != "7" {
		t.Fatalf("quota response %d %v %s", st, h, b)
	}
	if got := recorded(); len(got) != 1 || got[0] != (quotaCall{"token", f.ws, clientID, f.user}) {
		t.Fatalf("token quota key %v", got)
	}
	setDeny(false)
	st, tokens, b := f.exchange(public, req, code)
	if st != 200 {
		t.Fatalf("429 consumed the code: %d %s", st, b)
	}
	if st, _ := f.info(tokens.AccessToken); st != 200 {
		t.Fatal("userinfo")
	}
	if got := recorded(); len(got) != 3 || got[2] != (quotaCall{"userinfo", f.ws, clientID, f.user}) {
		t.Fatalf("userinfo quota key %v", got)
	}
}

// A registered SPA can read token error bodies; unauthenticated callers get no CORS.
func TestProviderTokenErrorsCarrySPACORS(t *testing.T) {
	f := fixture(t)
	spa := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_SPA, true)
	origin := "https://rp.example.test"
	form := url.Values{"client_id": {spa.Client.ClientId}, "grant_type": {"refresh_token"}, "refresh_token": {opaque("calab_or_")}}
	st, h, b := f.wire("POST", "/oidc/workspaces/"+f.ws.String()+"/token", "application/x-www-form-urlencoded", []byte(form.Encode()), "", origin)
	if st != 400 || !strings.Contains(string(b), "invalid_grant") || h.Get("Access-Control-Allow-Origin") != origin {
		t.Fatalf("SPA token error without CORS %d %v %s", st, h, b)
	}
	form.Set("client_id", "unknown")
	st, h, _ = f.wire("POST", "/oidc/workspaces/"+f.ws.String()+"/token", "application/x-www-form-urlencoded", []byte(form.Encode()), "", origin)
	if st != 401 || h.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("unknown client received CORS %d", st)
	}
	revoke := url.Values{"client_id": {spa.Client.ClientId}, "token": {opaque("calab_oa_")}}
	st, h, _ = f.wire("POST", "/oidc/workspaces/"+f.ws.String()+"/revoke", "application/x-www-form-urlencoded", []byte(revoke.Encode()), "", origin)
	if st != 200 || h.Get("Access-Control-Allow-Origin") != origin {
		t.Fatalf("SPA revoke without CORS %d", st)
	}
}

// One bounded binding cookie: an authorize loop cannot fill the cookie jar.
func TestProviderAuthorizeCookieIsBounded(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, false)
	var reqs []rpRequest
	for range 10 {
		reqs = append(reqs, f.begin(c.Client, nil))
	}
	root, _ := url.Parse(f.server.URL)
	cookies := f.http.Jar.Cookies(root)
	if len(cookies) != 1 || cookies[0].Name != requestCookieName || len(cookies[0].Value) > 400 {
		t.Fatalf("authorize cookies %d", len(cookies))
	}
	if st, _, _ := f.proto("POST", "/api/oauth/requests/"+reqs[5].handle+"/bind", &v1.BindOAuthRequest{CsrfToken: reqs[5].handle}); st == 200 {
		t.Fatal("evicted request still bound to the browser")
	}
	newest := f.bindRequest(reqs[9])
	older := f.bindRequest(reqs[6])
	if code := f.decision(newest, true, false); code == "" {
		t.Fatal("decision")
	}
	if code := f.decision(older, true, false); code == "" {
		t.Fatal("decision after another request's cleanup")
	}
	if st, _, _ := f.proto("POST", "/api/oauth/requests/"+reqs[9].handle+"/bind", &v1.BindOAuthRequest{CsrfToken: reqs[9].handle}); st == 200 {
		t.Fatal("decided request rebound")
	}
}

// A rename keeps existing grants but prompt=none must show the new name first.
func TestProviderRenameRequiresConsentForPromptNone(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	root, _ := url.Parse(f.server.URL)
	f.http.Jar.SetCookies(root, []*http.Cookie{{Name: "rp_test_session", Value: f.session.String(), Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode}})
	req, code := f.code(c.Client, true)
	st, tokens, b := f.exchange(c, req, code)
	if st != 200 {
		t.Fatalf("exchange %d %s", st, b)
	}
	silent := func() string {
		q := url.Values{"response_type": {"code"}, "client_id": {c.Client.ClientId}, "redirect_uri": {c.Client.RedirectUris[0]}, "scope": {"openid"}, "state": {"s"}, "nonce": {"n"}, "code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(hash(opaque("")))}, "prompt": {"none"}}
		st, h, b := f.wire("GET", "/oidc/workspaces/"+f.ws.String()+"/authorize?"+q.Encode(), "", nil, "", "")
		u, err := url.Parse(h.Get("Location"))
		if st != 303 || err != nil {
			t.Fatalf("prompt none %d %s", st, b)
		}
		if u.Query().Get("code") != "" {
			return "code"
		}
		return u.Query().Get("error")
	}
	if got := silent(); got != "code" {
		t.Fatalf("silent before rename: %s", got)
	}
	in := &v1.UpdateOAuthClientRequest{Version: c.Client.Version, Name: "Payroll", RedirectUris: c.Client.RedirectUris, Scopes: c.Client.Scopes, RefreshEnabled: true}
	if st, _, b := f.proto("PATCH", "/api/workspaces/"+f.ws.String()+"/oauth/clients/"+c.Client.Id, in); st != 200 {
		t.Fatalf("rename %d %s", st, b)
	}
	if got := silent(); got != "consent_required" {
		t.Fatalf("silent after rename: %s", got)
	}
	if st, _, b := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tokens.RefreshToken}}); st != 200 {
		t.Fatalf("rename revoked the existing grant %d %s", st, b)
	}
	_, _ = f.code(c.Client, false)
	if got := silent(); got != "code" {
		t.Fatalf("silent after re-consent: %s", got)
	}
}

// The sweeper removes expired requests, codes and access tokens and finished
// families after the replay window, and keeps everything still meaningful.
func TestProviderRetentionSweep(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	_ = f.begin(c.Client, nil)                // stale anonymous request
	freshReq := f.begin(c.Client, nil)        // live request
	oldReq, oldCode := f.code(c.Client, true) // aged below
	st, oldTokens, b := f.exchange(c, oldReq, oldCode)
	if st != 200 {
		t.Fatalf("exchange %d %s", st, b)
	}
	liveReq, liveCode := f.code(c.Client, true) // re-consent supersedes the first family
	st, liveTokens, b := f.exchange(c, liveReq, liveCode)
	if st != 200 {
		t.Fatalf("exchange %d %s", st, b)
	}
	ctx := context.Background()
	f.sql("UPDATE oauth_authorization_requests SET expires_at=clock_timestamp()-interval '1 minute' WHERE handle_hash<>$1", hash(freshReq.handle))
	// The superseded family was revoked by re-consent; age its revocation past the window.
	f.sql("UPDATE oauth_grants SET revoked_at=clock_timestamp()-interval '25 hours' WHERE revoked_at IS NOT NULL")
	// Live family: an access token expired beyond the grace, and a consumed code still inside the replay window.
	f.sql("UPDATE oauth_tokens SET created_at=clock_timestamp()-interval '2 hours 1 minute', expires_at=clock_timestamp()-interval '2 hours' WHERE token_hash=$1", hash(liveTokens.AccessToken))
	count := func(table string) int {
		var n int
		if err := f.d.Pool.QueryRow(ctx, "SELECT count(*) FROM "+pgx.Identifier{table}.Sanitize()).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	grantsBefore := count("oauth_grants")
	n, err := f.s.Sweep(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n == 0 || count("oauth_authorization_requests") != 1 || count("oauth_grants") != grantsBefore-1 || count("oauth_authorization_codes") != 1 {
		t.Fatalf("sweep %d: requests=%d grants=%d/%d codes=%d", n, count("oauth_authorization_requests"), count("oauth_grants"), grantsBefore, count("oauth_authorization_codes"))
	}
	var tokens int
	if err = f.d.Pool.QueryRow(ctx, "SELECT count(*) FROM oauth_tokens WHERE token_hash=ANY($1)", [][]byte{hash(oldTokens.AccessToken), hash(oldTokens.RefreshToken), hash(liveTokens.AccessToken)}).Scan(&tokens); err != nil {
		t.Fatal(err)
	}
	if tokens != 0 {
		t.Fatalf("%d swept tokens remain", tokens)
	}
	if st, _, b := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {liveTokens.RefreshToken}}); st != 200 {
		t.Fatalf("sweep broke the live family %d %s", st, b)
	}
	// Replay of the live consumed code inside the window still revokes its family.
	if st, _, _ := f.exchange(c, liveReq, liveCode); st != 400 {
		t.Fatal("code replay accepted")
	}
	_ = f.bindRequest(freshReq)
	// Past the window, the consumed code leaves too.
	f.sql("UPDATE oauth_authorization_codes SET created_at=clock_timestamp()-interval '25 hours', expires_at=clock_timestamp()-interval '25 hours'+interval '30 seconds'")
	if _, err = f.s.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if count("oauth_authorization_codes") != 0 {
		t.Fatal("expired code survived the replay window")
	}
}
