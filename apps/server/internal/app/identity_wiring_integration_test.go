//go:build integration

package app_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func identityHTTP(t *testing.T) (*app.App, string) {
	t.Helper()
	c := *testCfg
	c.IdentityPublicOrigin = "https://app.example.com"
	aes := bytes.Repeat([]byte{31}, 32)
	encryption, _ := json.Marshal(map[string]string{"active": base64.StdEncoding.EncodeToString(aes)})
	c.IdentityEncryptionKeys = string(encryption)
	c.IdentityEncryptionActiveKID = "active"
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signing, _ := json.Marshal(map[string]string{"active": string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))})
	c.OAuthSigningKeys = string(signing)
	c.OAuthSigningActiveKID = "active"
	a := app.New(app.Deps{Config: &c, DB: testDB, Redis: testRedis, Events: events.Redis{C: testRedis}, Blob: testStore, LiveKit: lkRec, Mail: testMail})
	srv := httptest.NewServer(a.Handler)
	t.Cleanup(srv.Close)
	return a, srv.URL
}
func identityRequest(t *testing.T, base, method, path, token, origin string, cookies []*http.Cookie, in proto.Message) (int, []byte, []*http.Cookie) {
	t.Helper()
	var body io.Reader = http.NoBody
	if in != nil {
		data, err := protojson.Marshal(in)
		if err != nil {
			t.Fatal(err)
		}
		body = io.NopCloser(bytes.NewReader(data))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, method, base+path, body)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", origin)
	r.Header.Set("X-Client", "web")
	r.Header.Set("X-Forwarded-For", "10.81.0.1")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	for _, cookie := range cookies {
		r.AddCookie(cookie)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, data, response.Cookies()
}

func TestIdentityHTTPScopedCookieRotationLogout(t *testing.T) {
	f := identitySetup(t, "optional")
	a, base := identityHTTP(t)
	origin := "https://app.example.com"
	path := "/api/auth/sso/workspaces/" + f.a.Id
	status, data, cookies := identityRequest(t, base, "POST", path+"/refresh", "", origin, nil, &v1.RefreshRequest{RefreshToken: f.scoped.refresh})
	if status != 200 {
		t.Fatalf("scoped refresh=%d %s", status, data)
	}
	var result v1.RefreshResponse
	if err := protojson.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	if result.Tokens.RefreshToken != "" || result.Tokens.Authority.WorkspaceId != f.a.Id || len(cookies) != 2 {
		t.Fatal("scoped browser token or cookie contract")
	}
	for _, cookie := range cookies {
		if cookie.Name == auth.RefreshCookie || cookie.Name == auth.LocalBrowserCookie || !cookie.Secure || !cookie.HttpOnly || cookie.Domain != "" {
			t.Fatal("scoped refresh replaced local authority or weakened cookie")
		}
		if strings.HasPrefix(cookie.Name, "__Secure-") && cookie.Path != path {
			t.Fatal("refresh cookie escaped workspace path")
		}
		if cookie.Expires.After(f.scopedSession.ExpiresAt.Add(time.Second)) {
			t.Fatal("refresh extended absolute deadline")
		}
	}
	if _, err := a.Auth.PrincipalFromRefresh(context.Background(), f.scoped.refresh); err == nil {
		t.Fatal("old browser cookie resolved after rotation")
	}
	status, _, _ = identityRequest(t, base, "POST", "/api/auth/sso/workspaces/"+f.b.Id+"/refresh", "", origin, cookies, &v1.RefreshRequest{})
	if status != 401 {
		t.Fatalf("cookie for A accepted by B: %d", status)
	}
	status, _, _ = identityRequest(t, base, "GET", "/api/workspaces/"+f.a.Id+"/identity", "", origin, cookies, nil)
	if status != 401 {
		t.Fatalf("management authenticated from cookie: %d", status)
	}
	status, _, _ = identityRequest(t, base, "POST", path+"/refresh", "", "https://evil.example", cookies, &v1.RefreshRequest{})
	if status != 403 {
		t.Fatal("cross-origin refresh accepted")
	}
	status, data, cleared := identityRequest(t, base, "POST", path+"/logout", "", origin, cookies, &v1.LogoutRequest{})
	if status != 204 || len(cleared) != 2 {
		t.Fatalf("logout=%d %s", status, data)
	}
	for _, cookie := range cleared {
		if cookie.MaxAge >= 0 {
			t.Fatal("workspace cookie not cleared")
		}
	}
	for _, cookie := range cookies {
		if _, err := a.Auth.PrincipalFromRefresh(context.Background(), cookie.Value); err == nil {
			t.Fatal("old cookie resolved after logout")
		}
	}
	if _, err := a.Auth.AuthenticateToken(context.Background(), f.local.token); err != nil {
		t.Fatal("scoped logout ended local device")
	}
}

func TestIdentityHTTPOriginCookieAndProtocolIsolation(t *testing.T) {
	f := identitySetup(t, "optional")
	a, base := identityHTTP(t)
	origin := "https://app.example.com"
	status, data, cookies := identityRequest(t, base, "POST", "/api/auth/login", "", origin, nil, &v1.LoginRequest{Email: f.local.email, Password: "password123"})
	if status != 200 || len(cookies) != 2 {
		t.Fatalf("web login=%d %s", status, data)
	}
	var login v1.LoginResponse
	if err := protojson.Unmarshal(data, &login); err != nil {
		t.Fatal(err)
	}
	var root *http.Cookie
	for _, cookie := range cookies {
		if cookie.Name == auth.LocalBrowserCookie {
			root = cookie
		}
	}
	if root == nil || root.Path != "/" || root.SameSite != http.SameSiteLaxMode || !root.Secure || !root.HttpOnly {
		t.Fatal("local optional-browser cookie contract")
	}
	status, _, _ = identityRequest(t, base, "POST", "/api/auth/local/reauth", login.Tokens.AccessToken, "https://evil.example", nil, &v1.LocalReauthRequest{CurrentPassword: "password123"})
	if status != 403 {
		t.Fatal("cross-origin reauth accepted")
	}
	status, data, _ = identityRequest(t, base, "POST", "/api/auth/local/reauth", login.Tokens.AccessToken, origin, nil, &v1.LocalReauthRequest{CurrentPassword: "password123"})
	if status != 200 {
		t.Fatalf("reauth=%d %s", status, data)
	}
	var proofs int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM session_workspace_assurances WHERE session_id=$1", uuid.MustParse(login.Tokens.SessionId)).Scan(&proofs); err != nil {
		t.Fatal(err)
	}
	if proofs != 0 {
		t.Fatal("local reauth minted corporate proof")
	}
	owner := owner(t)
	var created v1.OAuthClientSecretResponse
	status, data, _ = identityRequest(t, base, "POST", "/api/workspaces/"+f.a.Id+"/oauth/clients", owner.token, origin, nil, &v1.CreateOAuthClientRequest{Name: "App", Type: v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_SPA, RedirectUris: []string{"https://client.example/callback"}, AllowedOrigins: []string{"https://client.example"}, Scopes: []string{"openid"}})
	if status != 201 {
		t.Fatalf("clientcreate=%d %s", status, data)
	}
	if err := protojson.Unmarshal(data, &created); err != nil {
		t.Fatal(err)
	}
	challenge := sha256.Sum256([]byte(strings.Repeat("v", 43)))
	args := url.Values{"client_id": {created.Client.ClientId}, "redirect_uri": {"https://client.example/callback"}, "response_type": {"code"}, "scope": {"openid"}, "state": {"cookie-test"}, "nonce": {"nonce"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}, "prompt": {"none"}}
	authorize := "/oidc/workspaces/" + f.a.Id + "/authorize?" + args.Encode()
	// An unrelated bearer cannot silently switch the account tied to the browser cookie.
	status, data, _ = identityRequest(t, base, "GET", authorize, owner.token, origin, []*http.Cookie{root}, nil)
	if status != 302 && status != 303 {
		t.Fatalf("protocol error redirect=%d %s", status, data)
	}
	// Cookie introspection is read-only: mismatch did not rotate or revoke either device.
	if _, err := a.Auth.PrincipalFromRefresh(context.Background(), root.Value); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Auth.AuthenticateToken(context.Background(), owner.token); err != nil {
		t.Fatal(err)
	}
	status, data, _ = identityRequest(t, base, "GET", "/oidc/workspaces/"+f.a.Id+"/.well-known/openid-configuration", "", origin, nil, nil)
	if status != 200 || !strings.Contains(string(data), origin+"/oidc/workspaces/"+f.a.Id) || strings.Contains(string(data), base) {
		t.Fatalf("untrusted issuer origin=%d %s", status, data)
	}
	status, _, _ = identityRequest(t, base, "GET", "/api/me", "calab_oa_"+strings.Repeat("a", 43), origin, nil, nil)
	if status != 401 {
		t.Fatalf("provider token accepted as API principal: %d", status)
	}
}
