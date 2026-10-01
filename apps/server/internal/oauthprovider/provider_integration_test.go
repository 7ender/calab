//go:build integration

package oauthprovider

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/oauthprovider/signing"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type providerFixture struct {
	t                 *testing.T
	d                 *db.DB
	s                 *Service
	server            *httptest.Server
	http              *http.Client
	ws, user, session uuid.UUID
	private           []byte
}

func providerDB(t *testing.T) *db.DB {
	t.Helper()
	raw := os.Getenv("TEST_PG_URL")
	if raw == "" {
		raw = "postgres://identity_test:fixture-only-password@127.0.0.1:57418/identity_provider" // #nosec G101 -- Disposable local test fixture; never a production credential.
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close(ctx) })
	name := "oauth_provider_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)"); err != nil {
			t.Errorf("drop fixture: %v", err)
		}
	})
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	d, err := db.Connect(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	if err = d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	return d
}

func fixture(t *testing.T) *providerFixture {
	t.Helper()
	f := &providerFixture{t: t, d: providerDB(t), ws: uuid.New(), user: uuid.New(), session: uuid.New()}
	f.sql("INSERT INTO users(id,display_name,email,email_verified_at) VALUES($1,'Alice','alice@example.test',clock_timestamp())", f.user)
	f.sql("INSERT INTO workspaces(id,slug,name,owner_id) VALUES($1,$2,'Identity workspace',$3)", f.ws, "test-"+f.ws.String()[:8], f.user)
	f.sql("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", f.ws, f.user)
	f.sql("INSERT INTO workspace_plans(workspace_id,plan) VALUES($1,'enterprise')", f.ws)
	f.sql("INSERT INTO workspace_identity_grants(workspace_id,feature,enabled,source) VALUES($1,'oauth_provider',true,'cloud_business')", f.ws)
	f.sql("INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at,local_authenticated_at) VALUES($1,$2,$3,clock_timestamp()+interval '8 hours',clock_timestamp())", f.session, f.user, hash("fixture refresh"))
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f.private = pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	mux := http.NewServeMux()
	f.server = httptest.NewTLSServer(mux)
	t.Cleanup(f.server.Close)
	f.s, err = New(Config{DB: f.d, PublicOrigin: f.server.URL, Entitlements: identitypolicy.EntitlementConfig{Edition: "cloud"}, ResolveSession: func(ctx context.Context, r *http.Request) (identitypolicy.Principal, error) {
		raw := strings.TrimPrefix(bearer(r), "first_party_")
		if r.URL.Path == "/oidc/workspaces/"+f.ws.String()+"/authorize" {
			if c, err := r.Cookie("rp_test_session"); err == nil {
				raw = c.Value
			}
		}
		id, err := uuid.Parse(raw)
		if err != nil {
			return identitypolicy.Principal{}, identitypolicy.ErrDenied
		}
		session, err := f.d.Q.GetSession(ctx, id)
		if err != nil {
			return identitypolicy.Principal{}, err
		}
		p := identitypolicy.Principal{SessionID: session.ID, UserID: session.UserID, Authority: identitypolicy.Authority(session.AuthorityKind), ExpiresAt: session.ExpiresAt, Revoked: session.RevokedAt != nil, Version: session.AuthorityVersion}
		if session.LocalAuthenticatedAt != nil {
			p.LocalAuthenticatedAt = *session.LocalAuthenticatedAt
		}
		if session.AuthorityWorkspaceID != nil {
			p.WorkspaceID = *session.AuthorityWorkspaceID
		}
		if session.AuthorityConnectionID != nil {
			p.ConnectionID = *session.AuthorityConnectionID
		}
		return p, nil
	}, SignerForWorkspace: func(ws uuid.UUID) (*signing.Keyring, error) {
		return signing.New(signing.Config{Issuer: f.server.URL + "/oidc/workspaces/" + ws.String(), ActiveKID: "fixture-key", Now: func() time.Time { return f.s.c.Now() }, Keys: []signing.Key{{KID: "fixture-key", PEM: f.private}}})
	}})
	if err != nil {
		t.Fatal(err)
	}
	f.s.RegisterRoutes(mux)
	f.http = f.server.Client()
	f.http.Timeout = 10 * time.Second
	f.http.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	f.http.Jar, _ = cookiejar.New(nil)
	return f
}
func (f *providerFixture) sql(query string, args ...any) {
	f.t.Helper()
	if _, err := f.d.Pool.Exec(context.Background(), query, args...); err != nil {
		f.t.Fatal(err)
	}
}
func (f *providerFixture) wire(method, path, content string, body []byte, auth, origin string) (int, http.Header, []byte) {
	f.t.Helper()
	r, err := http.NewRequestWithContext(context.Background(), method, f.server.URL+path, bytes.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	if content != "" {
		r.Header.Set("Content-Type", content)
	}
	if auth != "" {
		r.Header.Set("Authorization", auth)
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	res, err := f.http.Do(r)
	if err != nil {
		f.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		f.t.Fatal(err)
	}
	return res.StatusCode, res.Header, b
}
func (f *providerFixture) proto(method, path string, in proto.Message) (int, http.Header, []byte) {
	f.t.Helper()
	var body []byte
	if in != nil {
		var err error
		body, err = protojson.Marshal(in)
		if err != nil {
			f.t.Fatal(err)
		}
	}
	return f.wire(method, path, "application/json", body, "Bearer first_party_"+f.session.String(), f.server.URL)
}
func (f *providerFixture) client(kind v1.OAuthClientType, refresh bool) *v1.OAuthClientSecretResponse {
	f.t.Helper()
	in := &v1.CreateOAuthClientRequest{Name: "Independent RP", Type: kind, RedirectUris: []string{"https://rp.example.test/callback"}, Scopes: []string{"openid", "profile", "email"}, RefreshEnabled: refresh}
	if kind == v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_SPA {
		in.AllowedOrigins = []string{"https://rp.example.test"}
	}
	status, _, body := f.proto("POST", "/api/workspaces/"+f.ws.String()+"/oauth/clients", in)
	if status != 201 {
		f.t.Fatalf("create client: %d %s", status, body)
	}
	out := &v1.OAuthClientSecretResponse{}
	if err := protojson.Unmarshal(body, out); err != nil {
		f.t.Fatal(err)
	}
	return out
}

type rpRequest struct{ handle, csrf, verifier, redirect, state, nonce string }

func (f *providerFixture) begin(c *v1.OAuthClient, extra url.Values) rpRequest {
	f.t.Helper()
	req := rpRequest{verifier: opaque(""), redirect: c.RedirectUris[0], state: opaque(""), nonce: opaque("")}
	q := url.Values{"response_type": {"code"}, "client_id": {c.ClientId}, "redirect_uri": {req.redirect}, "scope": {"openid profile email"}, "state": {req.state}, "nonce": {req.nonce}, "code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(hash(req.verifier))}}
	for k, v := range extra {
		q[k] = v
	}
	status, h, b := f.wire("GET", "/oidc/workspaces/"+f.ws.String()+"/authorize?"+q.Encode(), "", nil, "", "")
	if status != 303 {
		f.t.Fatalf("authorize: %d %s", status, b)
	}
	u, err := url.Parse(h.Get("Location"))
	if err != nil {
		f.t.Fatal(err)
	}
	req.handle = u.Query().Get("request")
	if req.handle == "" {
		f.t.Fatalf("expected consent redirect: %s", h.Get("Location"))
	}
	return req
}
func (f *providerFixture) bindRequest(req rpRequest) rpRequest {
	f.t.Helper()
	st, _, b := f.proto("POST", "/api/oauth/requests/"+req.handle+"/bind", &v1.BindOAuthRequest{CsrfToken: req.handle})
	if st != 200 {
		f.t.Fatalf("bind %d %s", st, b)
	}
	out := &v1.OAuthConsentSnapshot{}
	if err := protojson.Unmarshal(b, out); err != nil {
		f.t.Fatal(err)
	}
	req.csrf = out.CsrfToken
	return req
}
func (f *providerFixture) decision(req rpRequest, allow, refresh bool) string {
	f.t.Helper()
	st, _, b := f.proto("POST", "/api/oauth/requests/"+req.handle+"/decision", &v1.DecideOAuthRequest{Allow: allow, AllowRefresh: refresh, CsrfToken: req.csrf})
	if st != 200 {
		f.t.Fatalf("decision %d %s", st, b)
	}
	out := &v1.OAuthDecisionResponse{}
	if err := protojson.Unmarshal(b, out); err != nil {
		f.t.Fatal(err)
	}
	u, err := url.Parse(out.RedirectUrl)
	if err != nil {
		f.t.Fatal(err)
	}
	if u.Query().Get("state") != req.state || u.Query().Get("iss") != f.s.issuer(f.ws) {
		f.t.Fatal("RP rejected state/issuer")
	}
	return u.Query().Get("code")
}
func (f *providerFixture) code(c *v1.OAuthClient, refresh bool) (rpRequest, string) {
	req := f.bindRequest(f.begin(c, nil))
	return req, f.decision(req, true, refresh)
}
func (f *providerFixture) token(c *v1.OAuthClientSecretResponse, form url.Values) (int, tokenResponse, []byte) {
	f.t.Helper()
	auth := ""
	if c.SecretOnce != "" {
		auth = "Basic " + base64.StdEncoding.EncodeToString([]byte(url.QueryEscape(c.Client.ClientId)+":"+url.QueryEscape(c.SecretOnce)))
	} else {
		form.Set("client_id", c.Client.ClientId)
	}
	st, _, body := f.wire("POST", "/oidc/workspaces/"+f.ws.String()+"/token", "application/x-www-form-urlencoded", []byte(form.Encode()), auth, "")
	var out tokenResponse
	if st == 200 {
		if err := json.Unmarshal(body, &out); err != nil {
			f.t.Fatal(err)
		}
	}
	return st, out, body
}
func (f *providerFixture) exchange(c *v1.OAuthClientSecretResponse, req rpRequest, code string) (int, tokenResponse, []byte) {
	return f.token(c, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {req.redirect}, "code_verifier": {req.verifier}})
}
func (f *providerFixture) info(token string) (int, map[string]any) {
	st, _, b := f.wire("GET", "/oidc/workspaces/"+f.ws.String()+"/userinfo", "", nil, "Bearer "+token, "")
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		f.t.Fatal(err)
	}
	return st, out
}

// This RP verifies signatures from wire JWKS using the JWT library directly. It
// never calls the provider signer/Verify and does not inspect provider DB rows.
func (f *providerFixture) verifyID(raw, client, nonce string) jwt.MapClaims {
	f.t.Helper()
	st, h, b := f.wire("GET", "/oidc/workspaces/"+f.ws.String()+"/jwks", "", nil, "", "")
	if st != 200 || h.Get("Cache-Control") != "public, max-age=60" {
		f.t.Fatalf("JWKS %d %s", st, b)
	}
	var keys struct{ Keys []struct{ KID, N, E string } }
	if err := json.Unmarshal(b, &keys); err != nil {
		f.t.Fatal(err)
	}
	token, err := jwt.Parse(raw, func(t *jwt.Token) (any, error) {
		for _, key := range keys.Keys {
			if t.Header["kid"] == key.KID {
				n, err := base64.RawURLEncoding.DecodeString(key.N)
				if err != nil {
					return nil, err
				}
				e, err := base64.RawURLEncoding.DecodeString(key.E)
				if err != nil {
					return nil, err
				}
				return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}, nil
			}
		}
		return nil, signing.ErrToken
	}, jwt.WithValidMethods([]string{"RS256"}), jwt.WithIssuer(f.s.issuer(f.ws)), jwt.WithAudience(client), jwt.WithExpirationRequired(), jwt.WithIssuedAt())
	if err != nil || !token.Valid {
		f.t.Fatalf("independent ID verification: %v", err)
	}
	claims := token.Claims.(jwt.MapClaims)
	if nonce != "" && claims["nonce"] != nonce {
		f.t.Fatal("RP nonce mismatch")
	}
	if claims["auth_time"] == nil {
		f.t.Fatal("missing auth_time")
	}
	for _, forbidden := range []string{"user_id", "workspace_id", "roles", "superadmin", "amr", "acr"} {
		if _, ok := claims[forbidden]; ok {
			f.t.Fatalf("internal claim %s", forbidden)
		}
	}
	return claims
}

func TestProviderIndependentRPAndTokenIsolation(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, true)
	st, _, b := f.wire("GET", "/oidc/workspaces/"+f.ws.String()+"/.well-known/openid-configuration", "", nil, "", "")
	if st != 200 {
		t.Fatalf("discovery %d %s", st, b)
	}
	var metadata map[string]any
	if err := json.Unmarshal(b, &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata["issuer"] != f.s.issuer(f.ws) || metadata["token_endpoint"] != f.s.issuer(f.ws)+"/token" {
		t.Fatal("untrusted discovery origin")
	}
	req, code := f.code(c.Client, true)
	st, tokens, b := f.exchange(c, req, code)
	if st != 200 {
		t.Fatalf("exchange %d %s", st, b)
	}
	claims := f.verifyID(tokens.IDToken, c.Client.ClientId, req.nonce)
	st, info := f.info(tokens.AccessToken)
	if st != 200 || info["sub"] != claims["sub"] || info["name"] != "Alice" || info["email_verified"] != true {
		t.Fatalf("userinfo %d %+v", st, info)
	}
	for _, raw := range []string{tokens.IDToken, tokens.RefreshToken, "first_party_" + f.session.String(), "calab_bot_fixture", "eyJhbGciOiJIUzI1NiJ9.e30.signature"} {
		if st, _ := f.info(raw); st != 401 {
			t.Fatalf("confused token accepted %d", st)
		}
	}
	if st, _, _ := f.exchange(c, req, code); st != 400 {
		t.Fatal("authorization code replay accepted")
	}
	st, rotated, b := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tokens.RefreshToken}, "scope": {"openid"}})
	if st != 200 {
		t.Fatalf("refresh %d %s", st, b)
	}
	if st, info := f.info(rotated.AccessToken); st != 200 || len(info) != 1 || info["sub"] != claims["sub"] {
		t.Fatalf("scope narrowing %d %+v", st, info)
	}
	if st, _, _ := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {rotated.RefreshToken}, "scope": {"openid email"}}); st != 400 {
		t.Fatal("refresh widened scopes")
	}
	if st, _, _ := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tokens.RefreshToken}}); st != 400 {
		t.Fatal("refresh replay accepted")
	}
	if st, _ := f.info(rotated.AccessToken); st != 401 {
		t.Fatal("refresh reuse revocation rolled back")
	}
	var revoked int
	if err := f.d.Pool.QueryRow(context.Background(), "SELECT count(*) FROM oauth_grants WHERE revoked_reason='refresh_reuse'").Scan(&revoked); err != nil || revoked != 1 {
		t.Fatalf("durable replay revoke %d %v", revoked, err)
	}
}

func TestProviderParallelExchangeAndRefresh(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	req, code := f.code(c.Client, true)
	var success atomic.Int32
	var mutex sync.Mutex
	var winner tokenResponse
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() {
			st, out, b := f.exchange(c, req, code)
			if st == 200 {
				success.Add(1)
				mutex.Lock()
				winner = out
				mutex.Unlock()
			} else if st != 400 {
				t.Errorf("parallel code %d %s", st, b)
			}
		})
	}
	wg.Wait()
	if success.Load() != 1 {
		t.Fatalf("code successes %d", success.Load())
	}
	other := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	if st, _, _ := f.token(other, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {winner.RefreshToken}}); st != 400 {
		t.Fatal("wrong client refreshed")
	}
	if st, _ := f.info(winner.AccessToken); st != 200 {
		t.Fatal("wrong client caused revoke")
	}
	success.Store(0)
	var rotated tokenResponse
	for range 2 {
		wg.Go(func() {
			st, out, b := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {winner.RefreshToken}})
			if st == 200 {
				success.Add(1)
				mutex.Lock()
				rotated = out
				mutex.Unlock()
			} else if st != 400 {
				t.Errorf("parallel refresh %d %s", st, b)
			}
		})
	}
	wg.Wait()
	if success.Load() != 1 {
		t.Fatalf("refresh successes %d", success.Load())
	}
	if st, _ := f.info(rotated.AccessToken); st != 401 {
		t.Fatal("parallel refresh did not commit family revocation")
	}
}

func TestProviderConsentCSRFAndAccountBinding(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_SPA, true)
	req := f.begin(c.Client, nil)
	path := "/api/oauth/requests/" + req.handle + "/bind"
	input, _ := protojson.Marshal(&v1.BindOAuthRequest{CsrfToken: req.handle})
	for _, origin := range []string{"", "https://evil.example.test"} {
		st, _, _ := f.wire("POST", path, "application/json", input, "Bearer first_party_"+f.session.String(), origin)
		if st == 200 {
			t.Fatal("cross origin bind accepted")
		}
	}
	jar := f.http.Jar
	empty, _ := cookiejar.New(nil)
	f.http.Jar = empty
	st, _, _ := f.proto("POST", path, &v1.BindOAuthRequest{CsrfToken: req.handle})
	f.http.Jar = jar
	if st == 200 {
		t.Fatal("missing browser cookie accepted")
	}
	req = f.bindRequest(req)
	if st, _, _ := f.proto("POST", path, &v1.BindOAuthRequest{CsrfToken: req.handle}); st == 200 {
		t.Fatal("request rebound")
	}
	decisionPath := "/api/oauth/requests/" + req.handle + "/decision"
	if st, _, _ := f.proto("POST", decisionPath, &v1.DecideOAuthRequest{Allow: true, CsrfToken: opaque("calab_cs_")}); st == 200 {
		t.Fatal("wrong decision CSRF accepted")
	}
	other := uuid.New()
	otherSession := uuid.New()
	f.sql("INSERT INTO users(id,display_name,email) VALUES($1,'Mallory','mallory@example.test')", other)
	f.sql("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", f.ws, other)
	f.sql("INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at,local_authenticated_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',clock_timestamp())", otherSession, other, hash("other session"))
	input, _ = protojson.Marshal(&v1.DecideOAuthRequest{Allow: true, CsrfToken: req.csrf})
	st, _, _ = f.wire("POST", decisionPath, "application/json", input, "Bearer first_party_"+otherSession.String(), f.server.URL)
	if st == 200 {
		t.Fatal("account swap accepted")
	}
	code := f.decision(req, true, false)
	if st, _, _ := f.proto("POST", decisionPath, &v1.DecideOAuthRequest{Allow: true, CsrfToken: req.csrf}); st == 200 {
		t.Fatal("decision replay accepted")
	}
	st, tokens, b := f.exchange(c, req, code)
	if st != 200 || tokens.RefreshToken != "" {
		t.Fatalf("unconsented refresh issued %d %s", st, b)
	}
}
