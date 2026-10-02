//go:build integration

package app_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"google.golang.org/protobuf/encoding/protojson"
)

func quotaWire(t *testing.T, base, method, path, ip, bearer, basicUser, basicSecret string, form url.Values) (int, http.Header, []byte) {
	t.Helper()
	body := ""
	if form != nil {
		body = form.Encode()
	}
	req, err := http.NewRequestWithContext(context.Background(), method, base+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if ip != "" {
		req.Header.Set("X-Forwarded-For", ip)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if basicUser != "" {
		req.SetBasicAuth(url.QueryEscape(basicUser), url.QueryEscape(basicSecret))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, resp.Header, raw
}

// Cache only the real endpoint's proof deadline, with a minute of setup headroom.
// Full-package runs outlive the management proof; the account and session remain
// valid. Never extend DB timestamps or relax the production five-minute limit.
func ensureFixtureLocalProof(t *testing.T, u *user, base string, validUntil *time.Time) {
	t.Helper()
	if time.Until(*validUntil) > time.Minute {
		return
	}
	status, raw, _ := identityRequest(t, base, "POST", "/api/auth/local/reauth", u.token, "https://app.example.com", nil, &v1.LocalReauthRequest{CurrentPassword: "password123"})
	var proof v1.LocalReauthResponse
	if status != 200 || protojson.Unmarshal(raw, &proof) != nil || proof.ValidUntil == nil || time.Until(proof.ValidUntil.AsTime()) <= time.Minute {
		t.Fatalf("fixture local reauth=%d %s", status, raw)
	}
	*validUntil = proof.ValidUntil.AsTime()
}

var quotaOwnerProofUntil time.Time

func quotaClient(t *testing.T, base, ws string, kind v1.OAuthClientType) *v1.OAuthClientSecretResponse {
	t.Helper()
	o := owner(t)
	ensureFixtureLocalProof(t, o, base, &quotaOwnerProofUntil)
	status, raw, _ := identityRequest(t, base, "POST", "/api/workspaces/"+ws+"/oauth/clients", o.token, "https://app.example.com", nil, &v1.CreateOAuthClientRequest{Name: "Quota client", Type: kind, RedirectUris: []string{"https://client.example/callback"}, Scopes: []string{"openid"}})
	if status != 201 {
		t.Fatalf("client create=%d %s", status, raw)
	}
	c := &v1.OAuthClientSecretResponse{}
	if err := protojson.Unmarshal(raw, c); err != nil {
		t.Fatal(err)
	}
	return c
}
func quotaDenied(t *testing.T, status int, headers http.Header, raw []byte) {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	if status != 429 || body["error"] != "temporarily_unavailable" || headers.Get("Retry-After") == "" || headers.Get("Cache-Control") != "no-store" || headers.Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("quota protocol=%d %s", status, raw)
	}
}

func TestIdentityProviderTokenClientAndIPQuotas(t *testing.T) {
	f := identitySetup(t, "optional")
	_, base := identityHTTP(t)
	c := quotaClient(t, base, f.a.Id, v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB)
	path := "/oidc/workspaces/" + f.a.Id + "/token"
	form := url.Values{"grant_type": {"authorization_code"}, "redirect_uri": {"https://client.example/callback"}, "code": {"calab_oc_" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{22}, 32))}, "code_verifier": {strings.Repeat("v", 43)}}
	// Neither invalid credentials nor a valid secret with an unknown code spend the
	// client's budget: per-(client,user) buckets are charged only after the
	// provider found a live code or token, so no amount of such traffic is 429.
	for i := range 8 {
		status, _, _ := quotaWire(t, base, "POST", path, fmt.Sprintf("10.90.1.%d", i+1), "", c.Client.ClientId, "calab_os_"+base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{55}, 32)), form)
		if status != 401 {
			t.Fatalf("invalid client credentials=%d", status)
		}
	}
	for i := range 75 {
		status, _, raw := quotaWire(t, base, "POST", path, fmt.Sprintf("10.90.2.%d", i+1), "", c.Client.ClientId, c.SecretOnce, form)
		// Invalid code proves that the quota parser preserved and restored the form
		// and Basic credentials for the provider's own authentication/parser.
		if status != 400 || !bytes.Contains(raw, []byte("invalid_grant")) {
			t.Fatalf("restored form=%d %s", status, raw)
		}
	}
	// Public client_id + IP bucket: one IP cannot exhaust a shared NAT's budget.
	form.Set("client_id", "unregistered")
	started := time.Now()
	allowed := 0
	for range 75 {
		status, headers, raw := quotaWire(t, base, "POST", path, "10.90.3.1", "", "", "", form)
		if status == 429 {
			quotaDenied(t, status, headers, raw)
			break
		}
		if status != 401 {
			t.Fatalf("unknown client=%d %s", status, raw)
		}
		allowed++
	}
	if allowed < 60 || allowed > 60+int(math.Ceil(time.Since(started).Seconds())) || allowed >= 75 {
		t.Fatalf("client+IP bucket permits %d over %s", allowed, time.Since(started))
	}
	// The IP bucket covers rotating client_ids too. Its refill is two per second.
	started = time.Now()
	allowed = 0
	for i := range 140 {
		form.Set("client_id", fmt.Sprintf("unregistered-%d", i))
		status, headers, raw := quotaWire(t, base, "POST", path, "10.90.4.1", "", "", "", form)
		if status == 429 {
			quotaDenied(t, status, headers, raw)
			break
		}
		if status != 401 {
			t.Fatalf("unknown client=%d %s", status, raw)
		}
		allowed++
	}
	if allowed < 120 || allowed > 120+int(math.Ceil(time.Since(started).Seconds()*2)) || allowed >= 140 {
		t.Fatalf("IP bucket permits %d over %s", allowed, time.Since(started))
	}
}

func TestIdentityProviderManagementQuotaIsPerUser(t *testing.T) {
	f := identitySetup(t, "optional")
	_, base := identityHTTP(t)
	started := time.Now()
	allowed := 0
	for i := range 40 {
		token := f.local.token
		want := 200
		if i%3 == 0 {
			token = f.scoped.token
			want = 200
		}
		status, headers, raw := quotaWire(t, base, "GET", "/api/me/oauth-grants", fmt.Sprintf("10.91.1.%d", i+1), token, "", "", nil)
		if status == 429 {
			if headers.Get("Retry-After") == "" {
				t.Fatal("missing management Retry-After")
			}
			var e v1.ApiError
			if err := protojson.Unmarshal(raw, &e); err != nil {
				t.Fatal(err)
			}
			if e.Code != v1.ErrorCode_ERROR_CODE_RATE_LIMITED {
				t.Fatalf("management quota=%s", raw)
			}
			break
		}
		if status != want {
			t.Fatalf("management source=%d want=%d %s", status, want, raw)
		}
		allowed++
	}
	if allowed < 30 || allowed > 30+int(math.Ceil(time.Since(started).Seconds()/2)) || allowed >= 40 {
		t.Fatalf("user bucket permits %d over %s", allowed, time.Since(started))
	}
}

func TestIdentityProviderUserInfoQuotaAcrossMethodsAndTokens(t *testing.T) {
	f := identitySetup(t, "optional")
	_, base := identityHTTP(t)
	c := quotaClient(t, base, f.a.Id, v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_SPA)
	ctx := context.Background()
	ws := uuid.MustParse(f.a.Id)
	uid := uuid.MustParse(f.local.id)
	cid := uuid.MustParse(c.Client.Id)
	consent, err := testDB.Q.CreateOAuthConsent(ctx, sqlc.CreateOAuthConsentParams{WorkspaceID: ws, UserID: uid, ClientID: cid, Scopes: []string{"openid"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = testDB.Q.CreateOAuthSubject(ctx, sqlc.CreateOAuthSubjectParams{WorkspaceID: ws, UserID: uid, Subject: uuid.NewString()}); err != nil {
		t.Fatal(err)
	}
	state, err := identitypolicy.NewSQLLoader(testDB.Q, testCfg.IdentityEntitlements()).LoadIdentityState(ctx, f.scopedSession.ID, uid, ws)
	if err != nil {
		t.Fatal(err)
	}
	// Token rows enforce their TTL against the database clock, not the host clock.
	var until time.Time
	if err = testDB.Pool.QueryRow(ctx, "SELECT clock_timestamp() + interval '5 minutes'").Scan(&until); err != nil {
		t.Fatal(err)
	}
	grant, err := testDB.Q.CreateOAuthGrant(ctx, sqlc.CreateOAuthGrantParams{WorkspaceID: ws, UserID: uid, ClientID: cid, ConsentID: consent.ID, SessionID: f.scopedSession.ID, Scopes: []string{"openid"}, ClientVersion: 1, ConsentVersion: consent.Version, PolicyVersion: state.Policy.Version, AccessVersion: state.AccessVersion, SessionVersion: state.Principal.Version, AuthenticatedAt: state.Assurance.AuthenticatedAt, AssuranceExpiresAt: &state.Assurance.ValidUntil, ExpiresAt: until, IdleExpiresAt: until, EntitlementVersion: state.EntitlementVersion, Issuer: "https://app.example.com/oidc/workspaces/" + ws.String()})
	if err != nil {
		t.Fatal(err)
	}
	tokens := []string{}
	for i := range 2 {
		raw := "calab_oa_" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{byte(i + 72)}, 32))
		hash := sha256.Sum256([]byte(raw))
		if _, err = testDB.Q.CreateOAuthToken(ctx, sqlc.CreateOAuthTokenParams{WorkspaceID: ws, GrantID: grant.ID, UserID: uid, ClientID: cid, TokenHash: hash[:], TokenType: "access", ExpiresAt: until, Generation: int64(i + 1)}); err != nil {
			t.Fatal(err)
		}
		tokens = append(tokens, raw)
	}
	// Unknown bearers from many IPs are 401 and never spend the client budget.
	for i := range 100 {
		random := "calab_oa_" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{byte(i + 140)}, 32))
		if status, _, raw := quotaWire(t, base, "GET", "/oidc/workspaces/"+ws.String()+"/userinfo", fmt.Sprintf("10.92.2.%d", i+1), random, "", "", nil); status != 401 {
			t.Fatalf("unknown bearer=%d %s", status, raw)
		}
	}
	started := time.Now()
	allowed := 0
	for i := range 80 {
		method := "GET"
		if i%2 == 1 {
			method = "POST"
		}
		status, headers, raw := quotaWire(t, base, method, "/oidc/workspaces/"+ws.String()+"/userinfo", fmt.Sprintf("10.92.1.%d", i+1), tokens[i%2], "", "", nil)
		if status == 429 {
			quotaDenied(t, status, headers, raw)
			break
		}
		if status != 200 {
			t.Fatalf("userinfo=%d %s", status, raw)
		}
		allowed++
	}
	// Both tokens belong to one (client,user) bucket of 60/min.
	if allowed < 60 || allowed > 60+int(math.Ceil(time.Since(started).Seconds())) || allowed >= 80 {
		t.Fatalf("userinfo client-user bucket permits %d over %s", allowed, time.Since(started))
	}
}

type identityUnavailableQueries struct{}

func (identityUnavailableQueries) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, fmt.Errorf("injected database unavailable")
}
func (identityUnavailableQueries) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, fmt.Errorf("injected database unavailable")
}
func (identityUnavailableQueries) QueryRow(context.Context, string, ...any) pgx.Row {
	return identityUnavailableRow{}
}

type identityUnavailableRow struct{}

func (identityUnavailableRow) Scan(...any) error { return fmt.Errorf("injected database unavailable") }

func TestIdentityProviderManagementDependencyIs503(t *testing.T) {
	f := identitySetup(t, "optional")
	if _, err := testApp.Auth.AuthenticateToken(context.Background(), f.local.token); err != nil {
		t.Fatal(err)
	}
	failing := &db.DB{Pool: testDB.Pool, Q: sqlc.New(identityUnavailableQueries{})}
	_, base := identityHTTPWithDB(t, failing)
	status, _, raw := quotaWire(t, base, "GET", "/api/me/oauth-grants", "10.93.1.1", f.local.token, "", "", nil)
	var e v1.ApiError
	if err := protojson.Unmarshal(raw, &e); err != nil {
		t.Fatal(err)
	}
	if status != 503 || e.Code != v1.ErrorCode_ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE {
		t.Fatalf("dependency logged out valid credential: %d %s", status, raw)
	}
	if _, err := testApp.Auth.AuthenticateToken(context.Background(), f.local.token); err != nil {
		t.Fatal("dependency failure revoked the valid device")
	}
}

// Anonymous provider endpoints have IP buckets in front of any database work.
func TestIdentityProviderAnonymousIPQuotas(t *testing.T) {
	f := identitySetup(t, "optional")
	_, base := identityHTTP(t)
	for _, tc := range []struct {
		name, method, path string
		limit, want        int
	}{
		{"authorize", "GET", "/oidc/workspaces/" + f.a.Id + "/authorize", 60, 400},
		{"discovery", "GET", "/oidc/workspaces/" + f.a.Id + "/.well-known/openid-configuration", 120, 200},
		{"revoke", "POST", "/oidc/workspaces/" + f.a.Id + "/revoke", 120, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ip := "10.94." + fmt.Sprint(len(tc.name)) + ".1"
			started := time.Now()
			allowed := 0
			for range tc.limit + 15 {
				status, headers, raw := quotaWire(t, base, tc.method, tc.path, ip, "", "", "", nil)
				if status == 429 {
					quotaDenied(t, status, headers, raw)
					break
				}
				if status != tc.want {
					t.Fatalf("%s=%d %s", tc.name, status, raw)
				}
				allowed++
			}
			if allowed < tc.limit || allowed > tc.limit+int(math.Ceil(time.Since(started).Seconds()*float64(tc.limit)/60)) || allowed >= tc.limit+15 {
				t.Fatalf("%s IP bucket permits %d over %s", tc.name, allowed, time.Since(started))
			}
		})
	}
}
