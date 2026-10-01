package sso

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitynet"
	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
)

type fakeIDP struct {
	server          *httptest.Server
	key             *rsa.PrivateKey
	mu              sync.Mutex
	codes           map[string]fakeCode
	tokenCalls      int
	discoveryCalls  int
	changeDiscovery bool
}
type fakeCode struct {
	nonce, challenge, subject string
	changes                   map[string]any
}

func newIDP(t *testing.T) (*fakeIDP, *OIDC, sqlc.WorkspaceIdentityConnection) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeIDP{key: key, codes: map[string]fakeCode{}}
	f.server = httptest.NewTLSServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	parsed, _ := url.Parse(f.server.URL)
	roots := x509.NewCertPool()
	roots.AddCert(f.server.Certificate())
	protocol := &OIDC{Origin: "https://calaba.test", Policy: func(raw string) (identitynet.Endpoint, error) {
		u, e := url.Parse(raw)
		if e != nil || u.Host != parsed.Host {
			return identitynet.Endpoint{}, ErrInvalid
		}
		return identitynet.Endpoint{URL: raw, RootCAs: roots, TestLoopbackCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}}, nil
	}}
	c := sqlc.WorkspaceIdentityConnection{ID: uuid.New(), WorkspaceID: uuid.New(), Issuer: f.server.URL, Provider: "generic", ClientID: "fixture-client", Status: "active", Version: 1}
	return f, protocol, c
}
func (f *fakeIDP) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/.well-known/openid-configuration":
		f.mu.Lock()
		f.discoveryCalls++
		changed := f.changeDiscovery && f.discoveryCalls > 1
		f.mu.Unlock()
		authorization := f.server.URL + "/authorize"
		if changed {
			authorization = "https://unapproved.test/authorize"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"issuer": f.server.URL, "authorization_endpoint": authorization, "token_endpoint": f.server.URL + "/token", "jwks_uri": f.server.URL + "/jwks", "code_challenge_methods_supported": []string{"S256"}, "token_endpoint_auth_methods_supported": []string{"client_secret_basic", "client_secret_post"}})
	case "/jwks":
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &f.key.PublicKey, KeyID: "fixture", Algorithm: "RS256", Use: "sig"}}})
	case "/token":
		if r.ParseForm() != nil {
			http.Error(w, "invalid", 400)
			return
		}
		f.mu.Lock()
		f.tokenCalls++
		code, ok := f.codes[r.Form.Get("code")]
		delete(f.codes, r.Form.Get("code"))
		f.mu.Unlock()
		challenge, err := identitycrypto.S256(r.Form.Get("code_verifier"))
		if !ok || err != nil || challenge != code.challenge || r.Form.Get("grant_type") != "authorization_code" {
			http.Error(w, "invalid", 400)
			return
		}
		now := time.Now()
		claims := map[string]any{"iss": f.server.URL, "sub": code.subject, "aud": "fixture-client", "iat": now.Unix(), "exp": now.Add(5 * time.Minute).Unix(), "auth_time": now.Unix(), "nonce": code.nonce}
		for k, v := range code.changes {
			claims[k] = v
		}
		signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: f.key}, (&jose.SignerOptions{}).WithHeader("kid", "fixture"))
		if err != nil {
			http.Error(w, "failed", 500)
			return
		}
		payload, _ := json.Marshal(claims)
		signed, err := signer.Sign(payload)
		if err != nil {
			http.Error(w, "failed", 500)
			return
		}
		raw, err := signed.CompactSerialize()
		if err != nil {
			http.Error(w, "failed", 500)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fixture-access", "token_type": "Bearer", "id_token": raw})
	default:
		http.NotFound(w, r)
	}
}
func (f *fakeIDP) code(t *testing.T, auth string, subject string, changes map[string]any) (string, string) {
	t.Helper()
	u, err := url.Parse(auth)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" || q.Get("nonce") == "" || q.Get("max_age") != "3600" {
		t.Fatal("unsafe authorization request")
	}
	code := uuid.NewString()
	f.mu.Lock()
	f.codes[code] = fakeCode{nonce: q.Get("nonce"), challenge: q.Get("code_challenge"), subject: subject, changes: changes}
	f.mu.Unlock()
	return code, q.Get("state")
}
func TestOIDCClaimProfile(t *testing.T) {
	f, p, c := newIDP(t)
	cases := []struct {
		name    string
		changes map[string]any
		valid   bool
	}{
		{"valid", nil, true}, {"wrong_nonce", map[string]any{"nonce": "wrong"}, false}, {"wrong_issuer", map[string]any{"iss": "https://other.test"}, false}, {"wrong_audience", map[string]any{"aud": "other"}, false}, {"missing_azp", map[string]any{"aud": []string{"fixture-client", "other"}}, false}, {"wrong_azp", map[string]any{"azp": "other"}, false}, {"missing_auth_time", map[string]any{"auth_time": nil}, false}, {"stale_auth", map[string]any{"auth_time": time.Now().Add(-time.Hour).Unix()}, false}, {"future_iat", map[string]any{"iat": time.Now().Add(2 * time.Minute).Unix()}, false}, {"future_nbf", map[string]any{"nbf": time.Now().Add(2 * time.Minute).Unix()}, false}, {"expired", map[string]any{"exp": time.Now().Add(-time.Second).Unix()}, false}, {"blank_subject", map[string]any{"sub": ""}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			verifier, _ := identitycrypto.Secret()
			nonce, _ := identitycrypto.Secret()
			auth, err := p.Authorization(context.Background(), c, "state", nonce, verifier)
			if err != nil {
				t.Fatal(err)
			}
			code, _ := f.code(t, auth, "subject", tc.changes)
			proof, err := p.Exchange(context.Background(), c, "secret", code, verifier, identitycrypto.Hash(nonce))
			if tc.valid && (err != nil || proof.Subject != "subject") {
				t.Fatalf("valid proof %v %+v", err, proof)
			}
			if !tc.valid && err == nil {
				t.Fatal("invalid claim accepted")
			}
		})
	}
}
func TestDiscoverySingleSnapshot(t *testing.T) {
	f, p, c := newIDP(t)
	f.changeDiscovery = true
	verifier, _ := identitycrypto.Secret()
	auth, err := p.Authorization(context.Background(), c, "state", "nonce", verifier)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(auth)
	if u.Host != mustURL(f.server.URL).Host || f.discoveryCalls != 1 {
		t.Fatal("authorization changed between discovery reads")
	}
}
func mustURL(raw string) *url.URL { u, _ := url.Parse(raw); return u }
func TestEntraIssuerRestriction(t *testing.T) {
	tenant := uuid.NewString()
	base := sqlc.WorkspaceIdentityConnection{Provider: "entra", TenantID: tenant, Issuer: "https://login.microsoftonline.com/" + tenant + "/v2.0", ClientID: "client"}
	if !validIssuer(base) {
		t.Fatal("fixed tenant rejected")
	}
	for _, issuer := range []string{"https://login.microsoftonline.com/common/v2.0", "https://login.microsoftonline.com/organizations/v2.0", "https://login.microsoftonline.com/" + uuid.NewString() + "/v2.0"} {
		base.Issuer = issuer
		if validIssuer(base) {
			t.Fatal("unfixed tenant accepted")
		}
	}
}
