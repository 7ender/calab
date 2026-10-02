//go:build integration

package sso

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitynet"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"golang.org/x/net/html"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// These tests use real Keycloak signatures, token exchange and remote JWKS through
// the production OIDC implementation. Root auth/quota/token delivery are injected
// seams: this is RP interoperability acceptance, not application route coverage.
type keycloakFixture struct {
	s                                          *Service
	p                                          identitypolicy.Principal
	ws, other, connection                      uuid.UUID
	issuer, clientID, secret, adminToken, base string
	keycloakClient, basicScope                 string
	roots                                      *x509.CertPool
	mux                                        *http.ServeMux
}

func keycloakEnv(t *testing.T, key string) string {
	t.Helper()
	value := os.Getenv(key)
	if value == "" {
		t.Fatalf("live Keycloak requires %s", key)
	}
	return value
}

func newKeycloakFixture(t *testing.T) *keycloakFixture {
	t.Helper()
	issuer := keycloakEnv(t, "TEST_OIDC_ISSUER")
	u, err := url.Parse(issuer)
	if err != nil || u.Scheme != "https" || u.Hostname() != "127.0.0.1" || u.Path != "/realms/identity.test" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		t.Fatal("only the retained local TLS identity.test realm is permitted")
	}
	dsn := keycloakEnv(t, "TEST_PG_URL")
	pg, err := url.Parse(dsn)
	if err != nil || pg.Hostname() != "127.0.0.1" || pg.Path != "/identity_keycloak" {
		t.Fatal("dedicated local identity_keycloak database required")
	}
	pem, err := os.ReadFile(keycloakEnv(t, "TEST_OIDC_CA_FILE"))
	if err != nil {
		t.Fatal("cannot read fixture CA")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(pem) {
		t.Fatal("invalid fixture CA")
	}
	f := &keycloakFixture{issuer: issuer, base: "https://" + u.Host, roots: roots, ws: uuid.New(), other: uuid.New(), clientID: "calaba-rp-" + uuid.NewString()}
	f.secret, err = identitycrypto.Secret()
	if err != nil {
		t.Fatal(err)
	}
	f.adminToken = f.adminLogin(t)
	var info struct {
		SystemInfo struct {
			Version string `json:"version"`
		} `json:"systemInfo"`
	}
	f.admin(t, http.MethodGet, "/admin/serverinfo", nil, &info, http.StatusOK)
	if info.SystemInfo.Version != "26.4.7" {
		t.Fatalf("fixture version %s, need 26.4.7", info.SystemInfo.Version)
	}
	ctx := t.Context()
	d, err := db.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	if err = d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	keys, err := identitycrypto.New("keycloak-test", map[string][]byte{"keycloak-test": make([]byte, 32)})
	if err != nil {
		t.Fatal(err)
	}
	protocol := &OIDC{Origin: "https://calaba.test", Policy: func(_ uuid.UUID, raw string) (identitynet.Endpoint, error) {
		endpoint, e := url.Parse(raw)
		allowed := map[string]bool{u.Path + "/.well-known/openid-configuration": true, u.Path + "/protocol/openid-connect/auth": true, u.Path + "/protocol/openid-connect/token": true, u.Path + "/protocol/openid-connect/certs": true}
		if e != nil || endpoint.Scheme != "https" || endpoint.Host != u.Host || !allowed[endpoint.Path] || endpoint.RawQuery != "" || endpoint.Fragment != "" || endpoint.User != nil {
			return identitynet.Endpoint{}, ErrInvalid
		}
		return identitynet.Endpoint{URL: raw, RootCAs: roots, TestLoopbackCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}}, nil
	}}
	f.s = &Service{DB: d, Keys: keys, Protocol: protocol, Edition: identitypolicy.EntitlementConfig{Edition: "cloud"}, Sessions: fixtureIssuer{}}
	user, session, now := uuid.New(), uuid.New(), time.Now()
	// Alice's real verified fixture email deliberately matches an independently
	// prepared local account. Matching it must never substitute for explicit link.
	rows := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,email_verified_at,display_name,password_hash) VALUES($1,'alice@identity.test',$2,'Local Alice','fixture')`, []any{user, now}},
		{`INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at,local_authenticated_at) VALUES($1,$2,$3,$4,$5)`, []any{session, user, identitycrypto.Hash(uuid.NewString()), now.Add(time.Hour), now}},
	}
	for _, ws := range []uuid.UUID{f.ws, f.other} {
		rows = append(rows, struct {
			sql  string
			args []any
		}{`INSERT INTO workspaces(id,slug,name,owner_id) VALUES($1,$2,'Keycloak Acceptance',$3)`, []any{ws, "keycloak-" + ws.String()[:12], user}}, struct {
			sql  string
			args []any
		}{`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, []any{ws, user}})
	}
	rows = append(rows, struct {
		sql  string
		args []any
	}{`INSERT INTO workspace_plans(workspace_id,plan) VALUES($1,'enterprise') ON CONFLICT(workspace_id) DO UPDATE SET plan='enterprise'`, []any{f.ws}})
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, e := d.Pool.Exec(cleanupCtx, `DELETE FROM workspaces WHERE id=ANY($1::uuid[])`, []uuid.UUID{f.ws, f.other}); e != nil {
			t.Error("fixture workspace cleanup failed")
		}
		if _, e := d.Pool.Exec(cleanupCtx, `DELETE FROM users WHERE id=$1`, user); e != nil {
			t.Error("fixture user cleanup failed")
		}
	})
	for _, row := range rows {
		if _, err = d.Pool.Exec(ctx, row.sql, row.args...); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = d.Q.UpsertIdentityGrant(ctx, sqlc.UpsertIdentityGrantParams{WorkspaceID: f.ws, Feature: "corporate_sso", Source: "cloud_business", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	f.p = identitypolicy.Principal{SessionID: session, UserID: user, Authority: identitypolicy.LocalAccount, LocalAuthenticatedAt: now, ExpiresAt: now.Add(time.Hour), Version: 1}
	view, err := f.s.PutConnection(ctx, f.p, f.ws, &pb.PutIdentityConnectionRequest{Name: "Real Keycloak", Provider: pb.IdentityProvider_IDENTITY_PROVIDER_GENERIC, Issuer: issuer, ClientId: f.clientID, ClientSecret: &f.secret})
	if err != nil {
		t.Fatal(err)
	}
	f.connection = mustUUID(t, view.Id)
	client := map[string]any{"clientId": f.clientID, "enabled": true, "protocol": "openid-connect", "publicClient": false, "secret": f.secret, "standardFlowEnabled": true, "directAccessGrantsEnabled": false, "serviceAccountsEnabled": false, "redirectUris": []string{protocol.Origin + "/api/auth/sso/callback/" + view.Id}, "webOrigins": []string{}, "defaultClientScopes": []string{"basic", "profile", "email"}, "attributes": map[string]string{"pkce.code.challenge.method": "S256"}}
	f.admin(t, http.MethodPost, "/admin/realms/identity.test/clients", client, nil, http.StatusCreated)
	t.Cleanup(func() {
		// Refresh the short-lived bootstrap token before deleting only our client.
		f.adminToken = f.adminLogin(t)
		var clients []struct {
			ID       string `json:"id"`
			ClientID string `json:"clientId"`
		}
		f.admin(t, http.MethodGet, "/admin/realms/identity.test/clients?clientId="+url.QueryEscape(f.clientID), nil, &clients, http.StatusOK)
		if len(clients) != 1 || clients[0].ClientID != f.clientID {
			t.Error("temporary client cleanup lookup failed")
			return
		}
		f.admin(t, http.MethodDelete, "/admin/realms/identity.test/clients/"+clients[0].ID, nil, nil, http.StatusNoContent)
		clients = nil
		f.admin(t, http.MethodGet, "/admin/realms/identity.test/clients?clientId="+url.QueryEscape(f.clientID), nil, &clients, http.StatusOK)
		if len(clients) != 0 {
			t.Error("temporary client remains after cleanup")
		}
	})
	var clients []struct {
		ID       string `json:"id"`
		ClientID string `json:"clientId"`
	}
	f.admin(t, http.MethodGet, "/admin/realms/identity.test/clients?clientId="+url.QueryEscape(f.clientID), nil, &clients, http.StatusOK)
	if len(clients) != 1 || clients[0].ClientID != f.clientID {
		t.Fatal("temporary client lookup failed")
	}
	f.keycloakClient = clients[0].ID
	var scopes []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	f.admin(t, http.MethodGet, "/admin/realms/identity.test/client-scopes", nil, &scopes, http.StatusOK)
	for _, scope := range scopes {
		if scope.Name == "basic" {
			f.basicScope = scope.ID
		}
	}
	if f.basicScope == "" {
		t.Fatal("fixture has no built-in basic scope")
	}

	h := &HTTP{Service: f.s, Deps: HTTPDeps{
		Principal: func(r *http.Request, _ bool) (identitypolicy.Principal, error) {
			if r.Header.Get("Authorization") == "Bearer local-test-session" {
				return f.p, nil
			}
			return identitypolicy.Principal{}, nil
		},
		RateLimit: func(context.Context, string, int) (time.Duration, error) { return 0, nil },
		WriteError: func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, err.Error(), http.StatusForbidden)
		},
		WriteResult: func(w http.ResponseWriter, _ *http.Request, result Result) {
			writeProto(w, &pb.SSOCompleteResponse{Tokens: result.Tokens, Assurance: result.Assurance, Tested: result.Tested})
		},
	}}
	f.mux = http.NewServeMux()
	h.Routes(f.mux)
	return f
}

func (f *keycloakFixture) browser(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{Proxy: nil, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: f.roots}}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Jar: jar, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func (f *keycloakFixture) do(t *testing.T, client *http.Client, method, target, contentType string, body io.Reader) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), method, target, body)
	if err != nil {
		t.Fatal("invalid fixture request")
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := client.Do(req) //nolint:gosec // G704: local fixture URLs validated before every caller.
	if err != nil {
		t.Fatal("local TLS fixture request failed (URL and credentials redacted)")
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}
func (f *keycloakFixture) adminLogin(t *testing.T) string {
	t.Helper()
	form := url.Values{"grant_type": {"password"}, "client_id": {"admin-cli"}, "username": {keycloakEnv(t, "TEST_KEYCLOAK_ADMIN_USER")}, "password": {keycloakEnv(t, "TEST_KEYCLOAK_ADMIN_PASSWORD")}}
	// Password grant is solely bootstrap administration, never the Calaba RP flow.
	resp := f.do(t, f.browser(t), http.MethodPost, f.base+"/realms/master/protocol/openid-connect/token", "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	defer func() { _ = resp.Body.Close() }()
	var token struct {
		Access string `json:"access_token"`
	}
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&token) != nil || token.Access == "" {
		t.Fatal("fixture admin authentication failed")
	}
	return token.Access
}
func (f *keycloakFixture) admin(t *testing.T, method, path string, body, out any, want int) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, f.base+path, bytes.NewReader(raw))
	if err != nil {
		t.Fatal("invalid admin request")
	}
	req.Header.Set("Authorization", "Bearer "+f.adminToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := f.browser(t).Do(req) //nolint:gosec // G704: local synthetic fixture admin endpoint.
	if err != nil {
		t.Fatal("fixture admin request failed")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != want {
		t.Fatalf("fixture admin %s: status %d, want %d", method, resp.StatusCode, want)
	}
	if out != nil && json.NewDecoder(resp.Body).Decode(out) != nil {
		t.Fatal("invalid fixture admin response")
	}
}

func (f *keycloakFixture) request(t *testing.T, method, path string, body proto.Message, cookie *http.Cookie, local bool) *httptest.ResponseRecorder {
	t.Helper()
	var raw []byte
	if body != nil {
		var err error
		raw, err = protojson.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequestWithContext(t.Context(), method, f.s.Protocol.Origin+path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", f.s.Protocol.Origin)
	if local {
		req.Header.Set("Authorization", "Bearer local-test-session")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, req)
	return w
}
func keycloakStatus(t *testing.T, w *httptest.ResponseRecorder, want int) {
	t.Helper()
	if w.Code != want {
		t.Fatalf("RP HTTP status %d, want %d: %s", w.Code, want, w.Body.String())
	}
}
func keycloakRejected(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if w.Code < 400 {
		t.Fatalf("RP accepted invalid proof: HTTP %d", w.Code)
	}
}
func (f *keycloakFixture) begin(t *testing.T, purpose pb.SSOFlowPurpose, nativeChallenge string) (*pb.SSOBeginResponse, *http.Cookie) {
	t.Helper()
	kind := pb.SSOClientKind_SSO_CLIENT_KIND_WEB
	if nativeChallenge != "" {
		kind = pb.SSOClientKind_SSO_CLIENT_KIND_DESKTOP
	}
	w := f.request(t, http.MethodPost, "/api/auth/sso/workspaces/"+f.ws.String()+"/begin", &pb.SSOBeginRequest{Purpose: purpose, ClientKind: kind, DesktopChallenge: nativeChallenge}, nil, purpose != pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LOGIN)
	keycloakStatus(t, w, 200)
	var begin pb.SSOBeginResponse
	if protojson.Unmarshal(w.Body.Bytes(), &begin) != nil {
		t.Fatal("invalid begin response")
	}
	if nativeChallenge != "" {
		return &begin, nil
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].Path != "/" || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatal("unsafe RP browser binding")
	}
	return &begin, cookies[0]
}

// authorize submits Keycloak's actual login form; it never synthesizes a code,
// token or identity proof, and never follows the synthetic Calaba callback URL.
func (f *keycloakFixture) authorize(t *testing.T, auth, username, password string) string {
	t.Helper()
	u, err := url.Parse(auth)
	if err != nil || u.Scheme != "https" || "https://"+u.Host != f.base || u.Path != "/realms/identity.test/protocol/openid-connect/auth" {
		t.Fatal("unexpected authorization endpoint")
	}
	q := u.Query()
	expected := f.s.Protocol.Origin + "/api/auth/sso/callback/" + f.connection.String()
	if q.Get("redirect_uri") != expected || q.Get("client_id") != f.clientID || q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" || len(q.Get("code_challenge")) != 43 || len(q.Get("state")) != 43 || q.Get("nonce") == "" || q.Get("max_age") != "3600" || q.Get("prompt") != "login" {
		t.Fatal("unexpected RP authorization properties")
	}
	browser := f.browser(t)
	resp := f.do(t, browser, http.MethodGet, auth, "", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("Keycloak authorization HTTP %d", resp.StatusCode)
	}
	tokenizer := html.NewTokenizer(io.LimitReader(resp.Body, 1<<20))
	action := ""
	for tokenizer.Next() != html.ErrorToken {
		token := tokenizer.Token()
		if token.Type != html.StartTagToken || token.Data != "form" {
			continue
		}
		attrs := map[string]string{}
		for _, a := range token.Attr {
			attrs[a.Key] = a.Val
		}
		if attrs["id"] == "kc-form-login" {
			action = attrs["action"]
			break
		}
	}
	_ = resp.Body.Close()
	formURL, err := url.Parse(action)
	if err != nil || formURL.Scheme != "https" || "https://"+formURL.Host != f.base || !strings.HasPrefix(formURL.Path, "/realms/identity.test/login-actions/") {
		t.Fatal("missing or unsafe Keycloak login form")
	}
	form := url.Values{"username": {username}, "password": {password}, "credentialId": {""}}
	resp = f.do(t, browser, http.MethodPost, action, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == 200 {
		return ""
	}
	if resp.StatusCode != http.StatusFound && resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("Keycloak login HTTP %d", resp.StatusCode)
	}
	location, err := url.Parse(resp.Header.Get("Location"))
	if err != nil || location.Scheme != "https" || location.Host != "calaba.test" || location.Path != "/api/auth/sso/callback/"+f.connection.String() {
		t.Fatal("unsafe fixture login redirect")
	}
	if location.Query().Get("state") != q.Get("state") || location.Query().Get("code") == "" || location.Query().Get("error") != "" {
		t.Fatal("Keycloak authorization failed")
	}
	return location.RequestURI()
}
func (f *keycloakFixture) complete(t *testing.T, purpose pb.SSOFlowPurpose) *pb.SSOCompleteResponse {
	t.Helper()
	begin, cookie := f.begin(t, purpose, "")
	callback := f.authorize(t, begin.AuthorizationUrl, "alice", "fixture-only-alice-password")
	if callback == "" {
		t.Fatal("Alice received no authorization code")
	}
	w := f.request(t, http.MethodGet, callback, nil, cookie, false)
	keycloakStatus(t, w, http.StatusSeeOther)
	if w.Header().Get("Location") != "/sso/complete" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("unsafe completion redirect")
	}
	return f.finish(t, begin.FlowId, cookie)
}
func (f *keycloakFixture) finish(t *testing.T, flow string, cookie *http.Cookie) *pb.SSOCompleteResponse {
	t.Helper()
	w := f.request(t, http.MethodPost, "/api/auth/sso/finish", &pb.SSOFinishRequest{FlowId: flow}, cookie, false)
	keycloakStatus(t, w, 200)
	var out pb.SSOCompleteResponse
	if protojson.Unmarshal(w.Body.Bytes(), &out) != nil {
		t.Fatal("invalid finish response")
	}
	return &out
}
func (f *keycloakFixture) assertScoped(t *testing.T, out *pb.SSOCompleteResponse) {
	t.Helper()
	if out.Tokens == nil || out.Assurance == nil || out.Assurance.WorkspaceId != f.ws.String() {
		t.Fatal("missing scoped completion")
	}
	row, err := f.s.DB.Q.GetSession(t.Context(), mustUUID(t, out.Tokens.SessionId))
	if err != nil || row.UserID != f.p.UserID || row.AuthorityKind != "workspace_sso" || row.AuthorityWorkspaceID == nil || *row.AuthorityWorkspaceID != f.ws || row.AuthorityConnectionID == nil || *row.AuthorityConnectionID != f.connection || row.LocalAuthenticatedAt != nil {
		t.Fatal("session authority widened")
	}
	state, err := f.s.loader(f.s.DB.Q).LoadIdentityState(t.Context(), row.ID, row.UserID, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	if !identitypolicy.Evaluate(time.Now(), state, identitypolicy.WorkspaceRead).Allowed {
		t.Fatal("scoped session cannot read A")
	}
	if identitypolicy.CheckGlobal(time.Now(), state.Principal, identitypolicy.GlobalRead, false).Allowed {
		t.Fatal("scoped session acquired global authority")
	}
	state, err = f.s.loader(f.s.DB.Q).LoadIdentityState(t.Context(), row.ID, row.UserID, f.other)
	if err != nil {
		t.Fatal(err)
	}
	if identitypolicy.Evaluate(time.Now(), state, identitypolicy.WorkspaceRead).Allowed {
		t.Fatal("scoped session acquired B despite membership")
	}
}

func TestKeycloakLiveRP(t *testing.T) {
	if os.Getenv("CALABA_KEYCLOAK_LIVE") != "1" {
		t.Skip("live Keycloak acceptance not run: set CALABA_KEYCLOAK_LIVE=1 with retained fixture env")
	}
	f := newKeycloakFixture(t)

	ready := t.Run("missing_auth_time_rejected", func(t *testing.T) {
		path := "/admin/realms/identity.test/clients/" + f.keycloakClient + "/default-client-scopes/" + f.basicScope
		f.admin(t, http.MethodDelete, path, nil, nil, http.StatusNoContent)
		defer f.admin(t, http.MethodPut, path, nil, nil, http.StatusNoContent)
		begin, cookie := f.begin(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LINK, "")
		callback := f.authorize(t, begin.AuthorizationUrl, "alice", "fixture-only-alice-password")
		if callback == "" {
			t.Fatal("no code")
		}
		w := f.request(t, http.MethodGet, callback, nil, cookie, false)
		keycloakRejected(t, w)
		if strings.TrimSpace(w.Body.String()) != ErrInvalidProof.Error() {
			t.Fatal("missing auth_time was not rejected as invalid upstream proof")
		}
		keycloakRejected(t, f.request(t, http.MethodPost, "/api/auth/sso/finish", &pb.SSOFinishRequest{FlowId: begin.FlowId}, cookie, false))
		var count int
		if err := f.s.DB.Pool.QueryRow(t.Context(), `SELECT count(*) FROM workspace_external_identities WHERE workspace_id=$1`, f.ws).Scan(&count); err != nil || count != 0 {
			t.Fatal("missing auth_time linked identity")
		}
	})
	if !ready {
		t.Fatal("missing-auth-time negative failed; dependent scenarios not run")
	}
	ready = t.Run("explicit_link_test_activate", func(t *testing.T) {
		link := f.complete(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LINK)
		if link.Tokens != nil || link.Assurance != nil || link.Tested {
			t.Fatal("draft link granted authority")
		}
		var subject string
		if err := f.s.DB.Pool.QueryRow(t.Context(), `SELECT subject FROM workspace_external_identities WHERE workspace_id=$1 AND user_id=$2 AND issuer=$3`, f.ws, f.p.UserID, f.issuer).Scan(&subject); err != nil || subject == "" {
			t.Fatal("real subject not explicitly linked")
		}
		tested := f.complete(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_TEST)
		if !tested.Tested || tested.Tokens != nil || tested.Assurance != nil {
			t.Fatal("test issued authority")
		}
		if _, err := f.s.ActivateConnection(t.Context(), f.p, f.ws, f.connection, 1); err != nil {
			t.Fatal(err)
		}
	})
	if !ready {
		t.Fatal("live RP activation failed; dependent scenarios not run")
	}
	t.Run("standalone_web_binding_state_replay", func(t *testing.T) {
		begin, cookie := f.begin(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LOGIN, "")
		callback := f.authorize(t, begin.AuthorizationUrl, "alice", "fixture-only-alice-password")
		if callback == "" {
			t.Fatal("no code")
		}
		bad := *cookie //nolint:gosec // G124: intentionally corrupt an otherwise secure binding cookie.
		bad.Value = "wrong-browser"
		keycloakRejected(t, f.request(t, http.MethodGet, callback, nil, &bad, false))
		keycloakRejected(t, f.request(t, http.MethodGet, callback, nil, nil, false))
		target, _ := url.Parse(callback)
		query := target.Query()
		query.Set("state", strings.Repeat("x", 43))
		target.RawQuery = query.Encode()
		keycloakRejected(t, f.request(t, http.MethodGet, target.RequestURI(), nil, cookie, false))
		keycloakStatus(t, f.request(t, http.MethodGet, callback, nil, cookie, false), http.StatusSeeOther)
		keycloakRejected(t, f.request(t, http.MethodGet, callback, nil, cookie, false))
		keycloakRejected(t, f.request(t, http.MethodPost, "/api/auth/sso/finish", &pb.SSOFinishRequest{FlowId: begin.FlowId}, &bad, false))
		f.assertScoped(t, f.finish(t, begin.FlowId, cookie))
		keycloakRejected(t, f.request(t, http.MethodPost, "/api/auth/sso/finish", &pb.SSOFinishRequest{FlowId: begin.FlowId}, cookie, false))
	})
	t.Run("native_verifier_and_replay", func(t *testing.T) {
		verifier, err := identitycrypto.Secret()
		if err != nil {
			t.Fatal(err)
		}
		challenge, err := identitycrypto.S256(verifier)
		if err != nil {
			t.Fatal(err)
		}
		begin, _ := f.begin(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LOGIN, challenge)
		start := mustURL(begin.BrowserStartUrl).RequestURI()
		w := f.request(t, http.MethodGet, start, nil, nil, false)
		keycloakStatus(t, w, http.StatusSeeOther)
		cookies := w.Result().Cookies()
		if len(cookies) != 1 {
			t.Fatal("missing native browser cookie")
		}
		keycloakRejected(t, f.request(t, http.MethodGet, start, nil, nil, false))
		callback := f.authorize(t, w.Header().Get("Location"), "alice", "fixture-only-alice-password")
		if callback == "" {
			t.Fatal("no code")
		}
		w = f.request(t, http.MethodGet, callback, nil, cookies[0], false)
		keycloakStatus(t, w, http.StatusSeeOther)
		handoff := mustURL(w.Header().Get("Location"))
		if handoff.Scheme != "calab" || handoff.Host != "sso" || handoff.Path != "/complete" || handoff.Query().Get("flow") != begin.FlowId || handoff.Query().Get("ticket") == "" {
			t.Fatal("invalid native handoff")
		}
		exchange := &pb.SSOExchangeRequest{FlowId: begin.FlowId, Ticket: handoff.Query().Get("ticket"), Verifier: strings.Repeat("x", 43)}
		keycloakRejected(t, f.request(t, http.MethodPost, "/api/auth/sso/exchange", exchange, nil, false))
		exchange.Verifier = verifier
		w = f.request(t, http.MethodPost, "/api/auth/sso/exchange", exchange, nil, false)
		keycloakStatus(t, w, 200)
		var out pb.SSOCompleteResponse
		if protojson.Unmarshal(w.Body.Bytes(), &out) != nil {
			t.Fatal("invalid exchange response")
		}
		f.assertScoped(t, &out)
		keycloakRejected(t, f.request(t, http.MethodPost, "/api/auth/sso/exchange", exchange, nil, false))
	})
	t.Run("no_email_autolink", func(t *testing.T) {
		// Keep Alice's local email equal, but remove the explicit tuple. The real
		// upstream subject now proves login but must not select a local account.

		var originalSubject string
		if err := f.s.DB.Pool.QueryRow(t.Context(), `SELECT subject FROM workspace_external_identities WHERE workspace_id=$1`, f.ws).Scan(&originalSubject); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := f.s.DB.Pool.Exec(t.Context(), `UPDATE workspace_external_identities SET subject=$2 WHERE workspace_id=$1`, f.ws, originalSubject); err != nil {
				t.Error("restore explicit tuple failed")
			}
		}()
		if _, err := f.s.DB.Pool.Exec(t.Context(), `UPDATE workspace_external_identities SET subject=$2 WHERE workspace_id=$1`, f.ws, "unrelated-"+uuid.NewString()); err != nil {
			t.Fatal(err)
		}
		begin, cookie := f.begin(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LOGIN, "")
		callback := f.authorize(t, begin.AuthorizationUrl, "alice", "fixture-only-alice-password")
		if callback == "" {
			t.Fatal("no code")
		}
		w := f.request(t, http.MethodGet, callback, nil, cookie, false)
		keycloakRejected(t, w)
		if strings.TrimSpace(w.Body.String()) != ErrNotLinked.Error() {
			t.Fatal("equal-email login did not reach validated unlinked-subject denial")
		}
		keycloakRejected(t, f.request(t, http.MethodPost, "/api/auth/sso/finish", &pb.SSOFinishRequest{FlowId: begin.FlowId}, cookie, false))
		var count int
		if err := f.s.DB.Pool.QueryRow(t.Context(), `SELECT count(*) FROM workspace_external_identities WHERE workspace_id=$1`, f.ws).Scan(&count); err != nil || count != 1 {
			t.Fatal("email auto-created identity")
		}
	})
	t.Run("disabled_upstream_user", func(t *testing.T) {
		begin, cookie := f.begin(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LOGIN, "")
		if callback := f.authorize(t, begin.AuthorizationUrl, "disabled", "fixture-only-disabled-password"); callback != "" {
			t.Fatal("disabled upstream user received code")
		}
		keycloakRejected(t, f.request(t, http.MethodPost, "/api/auth/sso/finish", &pb.SSOFinishRequest{FlowId: begin.FlowId}, cookie, false))
	})
	t.Run("normal_step_up_preserves_local_authority", func(t *testing.T) {
		before, err := f.s.DB.Q.GetSession(t.Context(), f.p.SessionID)
		if err != nil {
			t.Fatal(err)
		}
		out := f.complete(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_STEP_UP)
		after, err := f.s.DB.Q.GetSession(t.Context(), f.p.SessionID)
		if err != nil || out.Tokens != nil || out.Assurance == nil || out.Assurance.WorkspaceId != f.ws.String() || after.AuthorityKind != "local_account" || after.AuthorityWorkspaceID != nil || after.AuthorityConnectionID != nil || after.LocalAuthenticatedAt == nil || before.LocalAuthenticatedAt == nil || !after.LocalAuthenticatedAt.Equal(*before.LocalAuthenticatedAt) || !after.ExpiresAt.Equal(before.ExpiresAt) {
			t.Fatal("step-up replaced or widened local session")
		}
		state, err := f.s.loader(f.s.DB.Q).LoadIdentityState(t.Context(), after.ID, after.UserID, f.other)
		if err != nil {
			t.Fatal(err)
		}
		if !identitypolicy.Evaluate(time.Now(), state, identitypolicy.WorkspaceRead).Allowed || !identitypolicy.CheckGlobal(time.Now(), state.Principal, identitypolicy.GlobalRead, false).Allowed {
			t.Fatal("step-up lost independent local authority")
		}
	})
	t.Run("real_upstream_PKCE_nonce_code_replay_and_JWKS", func(t *testing.T) {
		c, err := f.s.DB.Q.GetIdentityConnectionForUpdate(t.Context(), sqlc.GetIdentityConnectionForUpdateParams{WorkspaceID: f.ws, ID: f.connection})
		if err != nil {
			t.Fatal(err)
		}
		liveCode := func() (string, string, string) {
			t.Helper()
			verifier, e := identitycrypto.Secret()
			if e != nil {
				t.Fatal(e)
			}
			nonce, e := identitycrypto.Secret()
			if e != nil {
				t.Fatal(e)
			}
			state, e := identitycrypto.Secret()
			if e != nil {
				t.Fatal(e)
			}
			auth, e := f.s.Protocol.Authorization(t.Context(), c, state, nonce, verifier)
			if e != nil {
				t.Fatal(e)
			}
			callback := f.authorize(t, auth, "alice", "fixture-only-alice-password")
			if callback == "" {
				t.Fatal("no code")
			}
			return mustURL(callback).Query().Get("code"), verifier, nonce
		}
		code, verifier, nonce := liveCode()
		proof, err := f.s.Protocol.Exchange(t.Context(), c, f.secret, code, verifier, identitycrypto.Hash(nonce))
		if err != nil || proof.Issuer != f.issuer || proof.Subject == "" || proof.AuthenticatedAt.IsZero() {
			t.Fatal("real upstream exchange/signature verification failed")
		}
		if _, err = f.s.Protocol.Exchange(t.Context(), c, f.secret, code, verifier, identitycrypto.Hash(nonce)); !errors.Is(err, ErrInvalidProof) {
			t.Fatal("real upstream code replay accepted")
		}
		code, _, nonce = liveCode()
		if _, err = f.s.Protocol.Exchange(t.Context(), c, f.secret, code, strings.Repeat("x", 43), identitycrypto.Hash(nonce)); !errors.Is(err, ErrInvalidProof) {
			t.Fatal("real upstream bad PKCE accepted")
		}
		code, verifier, _ = liveCode()
		if _, err = f.s.Protocol.Exchange(t.Context(), c, f.secret, code, verifier, identitycrypto.Hash("wrong-nonce")); !errors.Is(err, ErrInvalidProof) {
			t.Fatal("real upstream nonce mismatch accepted")
		}
		code, verifier, nonce = liveCode()
		noJWKS := *f.s.Protocol
		policy := noJWKS.Policy
		noJWKS.Policy = func(ws uuid.UUID, raw string) (identitynet.Endpoint, error) {
			if strings.HasSuffix(raw, "/certs") {
				return identitynet.Endpoint{}, ErrInvalid
			}
			return policy(ws, raw)
		}
		if _, err = noJWKS.Exchange(t.Context(), c, f.secret, code, verifier, identitycrypto.Hash(nonce)); !errors.Is(err, ErrInvalidProof) {
			t.Fatal("unapproved JWKS accepted")
		}
	})
}
