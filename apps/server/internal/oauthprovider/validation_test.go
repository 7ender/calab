package oauthprovider

import (
	"encoding/base64"
	"net/url"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

func TestRedirectExactness(t *testing.T) {
	for _, tc := range []struct {
		raw, registered, kind string
		want                  bool
	}{
		{"https://rp.example/callback", "https://rp.example/callback", "confidential_web", true},
		{"https://rp.example/callback/child", "https://rp.example/callback", "confidential_web", false},
		{"https://rp.example/callback?x=1", "https://rp.example/callback", "public_spa", false},
		{"https://rp.example/callback#secret", "https://rp.example/callback", "public_spa", false},
		{"https://rp.example.evil/callback", "https://rp.example/callback", "confidential_web", false},
		{"https://user@rp.example/callback", "https://rp.example/callback", "confidential_web", false},
		{"http://127.0.0.1:49152/callback?x=1", "http://127.0.0.1/callback?x=1", "public_native", true},
		{"http://[::1]:49152/callback", "http://[::1]/callback", "public_native", true},
		{"http://localhost:49152/callback", "http://127.0.0.1/callback", "public_native", false},
		{"http://127.0.0.2:49152/callback", "http://127.0.0.1/callback", "public_native", false},
		{"http://127.0.0.1:49152/other", "http://127.0.0.1/callback", "public_native", false},
		{"http://127.0.0.1:49152/callback", "http://127.0.0.1/callback", "public_spa", false},
		{"com.example.app:/callback", "com.example.app:/callback", "public_native", true},
		{"com.example.app:/callback", "com.example.app:/callback", "confidential_web", false},
		{"https://rp.example/%63allback", "https://rp.example/callback", "confidential_web", false},
	} {
		t.Run(tc.raw+"/"+tc.kind, func(t *testing.T) {
			if got := redirectMatches(tc.raw, tc.registered, tc.kind); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestAuthorizeValidation(t *testing.T) {
	c := sqlc.OauthClient{Scopes: []string{"openid", "profile", "email"}}
	base := url.Values{"response_type": {"code"}, "redirect_uri": {"https://rp.example/callback"}, "scope": {"openid profile"}, "state": {"state"}, "nonce": {"nonce"}, "code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(hash("verifier"))}}
	for _, tc := range []struct{ key, value, code string }{
		{"response_type", "token", "unsupported_response_type"}, {"code_challenge_method", "plain", "invalid_request"}, {"code_challenge", "abc", "invalid_request"}, {"state", "", "invalid_request"}, {"nonce", "", "invalid_request"}, {"scope", "openid offline_access", "invalid_scope"}, {"scope", "openid profile profile", "invalid_scope"}, {"prompt", "none login", "invalid_request"}, {"prompt", "none consent", "invalid_request"}, {"prompt", "select_account", "invalid_request"}, {"max_age", "-1", "invalid_request"}, {"max_age", "2147483648", "invalid_request"}, {"request_uri", "https://evil.example/jar", "invalid_request"}, {"claims", "{}", "invalid_request"}, {"id_token_hint", "not-a-jwt", "invalid_request"},
	} {
		t.Run(tc.key+tc.value, func(t *testing.T) {
			f := url.Values{}
			for k, v := range base {
				f[k] = v
			}
			f.Set(tc.key, tc.value)
			_, err := parseAuthorize(f, c)
			if err == nil || err.Error() != "oauthprovider: "+tc.code {
				t.Fatalf("got %v", err)
			}
		})
	}
	for _, prompt := range []string{"none", " none ", "\tnone\n"} {
		f := url.Values{}
		for k, v := range base {
			f[k] = v
		}
		f.Set("prompt", prompt)
		req, err := parseAuthorize(f, c)
		if err != nil || req.Prompt != "none" {
			t.Fatalf("prompt %q: %q %v", prompt, req.Prompt, err)
		}
	}
	f := url.Values{}
	for k, v := range base {
		f[k] = v
	}
	f["state"] = []string{"one", "two"}
	if _, err := parseAuthorize(f, c); err == nil {
		t.Fatal("duplicate state accepted")
	}
	f.Set("state", "state")
	f.Set("acr_values", "unsupported-mfa-preference another-preference")
	if req, err := parseAuthorize(f, c); err != nil || req.State != "state" || req.PkceChallenge != base.Get("code_challenge") {
		t.Fatalf("optional acr preference changed authorization: %+v %v", req, err)
	}
	f["acr_values"] = []string{"one", "two"}
	if _, err := parseAuthorize(f, c); err == nil {
		t.Fatal("duplicate acr_values accepted")
	}
}

func TestAuthenticationFreshness(t *testing.T) {
	now := time.Now()
	zero := int32(0)
	age := int32(60)
	if freshAuthentication(now, now.Add(-time.Minute), now.Add(-2*time.Minute), "login", nil) {
		t.Fatal("old login accepted")
	}
	if freshAuthentication(now, now.Add(-time.Minute), now.Add(-2*time.Minute), "", &zero) {
		t.Fatal("max_age=0 accepted stale auth")
	}
	if freshAuthentication(now, now.Add(-time.Minute), now.Add(-2*time.Minute), "", &age) {
		t.Fatal("max_age accepted stale auth")
	}
	if !freshAuthentication(now, now.Add(-time.Minute), now.Add(-time.Second), "login consent", &zero) {
		t.Fatal("new authentication rejected")
	}
	if freshAuthentication(now, now, time.Time{}, "", nil) {
		t.Fatal("migration without auth time accepted")
	}
}

func TestOpaqueSeparation(t *testing.T) {
	for _, prefix := range []string{"calab_oa_", "calab_or_", "calab_oc_", "calab_os_"} {
		raw := opaque(prefix)
		if !tokenShape(raw, prefix) {
			t.Fatal("generated token invalid")
		}
		for _, other := range []string{"calab_oa_", "calab_or_", "calab_oc_", "calab_os_"} {
			if other != prefix && tokenShape(raw, other) {
				t.Fatal("cross token type accepted")
			}
		}
	}
}
