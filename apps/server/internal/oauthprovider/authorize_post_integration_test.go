//go:build integration

package oauthprovider

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func postAuthorization(c *v1.OAuthClient) (rpRequest, url.Values) {
	req := rpRequest{verifier: opaque(""), redirect: c.RedirectUris[0], state: opaque(""), nonce: opaque("")}
	return req, url.Values{"response_type": {"code"}, "client_id": {c.ClientId}, "redirect_uri": {req.redirect}, "scope": {"openid profile email"}, "state": {req.state}, "nonce": {req.nonce}, "code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(hash(req.verifier))}}
}

func TestProviderAuthorizationPOSTConsentAndBindings(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_SPA, true)
	req, form := postAuthorization(c.Client)
	form.Set("acr_values", "unsupported-mfa-preference")
	path := "/oidc/workspaces/" + f.ws.String() + "/authorize"
	st, h, b := f.wire("POST", path, "application/x-www-form-urlencoded; charset=UTF-8", []byte(form.Encode()), "", c.Client.AllowedOrigins[0])
	if st != http.StatusSeeOther || h.Get("Access-Control-Allow-Origin") != "" || h.Get("Cache-Control") != "no-store" {
		t.Fatalf("POST authorize: %d %v %s", st, h, b)
	}
	u, err := url.Parse(h.Get("Location"))
	if err != nil || u.Path != "/oauth/consent" {
		t.Fatalf("POST consent location: %v %v", u, err)
	}
	req.handle = u.Query().Get("request")
	if !tokenShape(req.handle, "calab_oh_") {
		t.Fatal("POST did not create a bound request")
	}
	req = f.bindRequest(req)
	code := f.decision(req, true, true)
	bad := req
	bad.verifier = opaque("")
	if st, _, _ := f.exchange(c, bad, code); st != 400 {
		t.Fatal("POST code lost PKCE binding")
	}
	bad = req
	bad.redirect += "/child"
	if st, _, _ := f.exchange(c, bad, code); st != 400 {
		t.Fatal("POST code lost redirect binding")
	}
	st, tokens, b := f.exchange(c, req, code)
	if st != http.StatusOK || tokens.RefreshToken == "" {
		t.Fatalf("POST exchange: %d %s", st, b)
	}
	f.verifyID(tokens.IDToken, c.Client.ClientId, req.nonce)
}

func TestProviderAuthorizationPOSTRejectsAmbiguousAndMalformedForms(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, false)
	_, form := postAuthorization(c.Client)
	path := "/oidc/workspaces/" + f.ws.String() + "/authorize"
	for _, tc := range []struct{ name, query, media, body string }{
		{"query and body", "?state=ambiguous", "application/x-www-form-urlencoded", form.Encode()},
		{"same query and body", "?client_id=" + c.Client.ClientId, "application/x-www-form-urlencoded", form.Encode()},
		{"duplicate client", "", "application/x-www-form-urlencoded", form.Encode() + "&client_id=" + c.Client.ClientId},
		{"duplicate redirect", "", "application/x-www-form-urlencoded", form.Encode() + "&redirect_uri=" + url.QueryEscape(form.Get("redirect_uri"))},
		{"duplicate state", "", "application/x-www-form-urlencoded", form.Encode() + "&state=other"},
		{"duplicate acr preference", "", "application/x-www-form-urlencoded", form.Encode() + "&acr_values=one&acr_values=two"},
		{"malformed escape", "", "application/x-www-form-urlencoded", form.Encode() + "&state=%zz"},
		{"semicolon", "", "application/x-www-form-urlencoded", form.Encode() + "&unknown=a;b"},
		{"oversize", "", "application/x-www-form-urlencoded", strings.Repeat("x", (16<<10)+1)},
		{"oversize field", "", "application/x-www-form-urlencoded", form.Encode() + "&unknown=" + strings.Repeat("x", 4097)},
		{"JSON", "", "application/json", `{}`},
		{"missing content type", "", "", form.Encode()},
		{"multipart", "", "multipart/form-data; boundary=test", form.Encode()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, h, b := f.wire("POST", path+tc.query, tc.media, []byte(tc.body), "", "")
			if st != 400 || h.Get("Location") != "" || !strings.Contains(string(b), `"error":"invalid_request"`) || h.Get("Access-Control-Allow-Origin") != "" {
				t.Fatalf("invalid POST: %d %v %s", st, h, b)
			}
		})
	}
	var requests int
	if err := f.d.Pool.QueryRow(context.Background(), "SELECT count(*) FROM oauth_authorization_requests").Scan(&requests); err != nil || requests != 0 {
		t.Fatalf("invalid form created requests: %d %v", requests, err)
	}
	for _, tc := range []struct{ key, value, want string }{
		{"request_uri", "https://untrusted.example.test/request", "invalid_request"},
		{"id_token_hint", "not-a-jwt", "invalid_request"},
		{"response_type", "token", "unsupported_response_type"},
		{"code_challenge_method", "plain", "invalid_request"},
		{"scope", "openid offline_access", "invalid_scope"},
		{"state", "", "invalid_request"},
		{"nonce", "", "invalid_request"},
		{"prompt", "none", "login_required"},
	} {
		for _, method := range []string{"GET", "POST"} {
			t.Run(method+"/"+tc.key, func(t *testing.T) {
				_, input := postAuthorization(c.Client)
				input.Set(tc.key, tc.value)
				p, body, media := path, []byte(input.Encode()), "application/x-www-form-urlencoded"
				if method == "GET" {
					p, body, media = path+"?"+input.Encode(), nil, ""
				}
				st, h, b := f.wire(method, p, media, body, "", "")
				u, err := url.Parse(h.Get("Location"))
				if st != http.StatusSeeOther || err != nil || u.Query().Get("error") != tc.want || u.Query().Get("state") != input.Get("state") || u.Query().Get("iss") != f.s.issuer(f.ws) {
					t.Fatalf("authorization validation: %d %v %s (%v)", st, h, b, err)
				}
			})
		}
	}
	form.Set("redirect_uri", "https://untrusted.example.test/callback")
	st, h, _ := f.wire("POST", path, "application/x-www-form-urlencoded", []byte(form.Encode()), "", "")
	if st != 400 || h.Get("Location") != "" {
		t.Fatal("POST redirected to an unregistered URI")
	}
}
