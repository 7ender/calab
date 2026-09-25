//go:build integration

package app_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

type webResp struct {
	status int
	cookie *http.Cookie // calaba_refresh from Set-Cookie, if any
	body   []byte
}

// webPost sends a browser-like request: explicit headers, cookie managed by the test
// (Go's cookie jar would refuse a Secure cookie over the plain-HTTP test server).
func webPost(t *testing.T, path string, in proto.Message, hdr map[string]string, cookie string) webResp {
	t.Helper()
	var body io.Reader = http.NoBody
	if in != nil {
		b, _ := protojson.Marshal(in)
		body = bytes.NewReader(b)
	}
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, srv.URL+path, body)
	req.Header.Set("X-Forwarded-For", "10.77.0.1")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	if cookie != "" {
		req.Header.Set("Cookie", "calaba_refresh="+cookie) // request cookie: attributes do not apply
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	out := webResp{status: resp.StatusCode}
	out.body, _ = io.ReadAll(resp.Body)
	for _, c := range resp.Cookies() {
		if c.Name == "calaba_refresh" {
			out.cookie = c
		}
	}
	return out
}

var goodOrigin = map[string]string{"X-Client": "web", "Origin": "https://app.example.com"}

func TestWebCookieAuth(t *testing.T) {
	o := owner(t)
	email := mustEmail(t, o)
	login := &v1.LoginRequest{Email: email, Password: "password123", DeviceName: "browser"}

	// Web login: refresh token only in an HttpOnly, Secure, SameSite=Strict cookie.
	r := webPost(t, "/api/auth/login", login, goodOrigin, "")
	if r.status != 200 || r.cookie == nil {
		t.Fatalf("web login: %d %s", r.status, r.body)
	}
	var lr v1.LoginResponse
	_ = protojson.Unmarshal(r.body, &lr)
	c := r.cookie
	if lr.GetTokens().GetRefreshToken() != "" || lr.GetTokens().GetAccessToken() == "" {
		t.Fatal("refresh token leaked into the body, or no access token")
	}
	if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode || c.Path != "/api/auth" || c.MaxAge <= 0 {
		t.Fatalf("cookie attributes: %+v", c)
	}

	// Login from a foreign origin (login CSRF) is rejected; the ALT domain is accepted.
	if r := webPost(t, "/api/auth/login", login, map[string]string{"X-Client": "web", "Origin": "https://evil.example.com"}, ""); r.status != 403 || r.cookie != nil {
		t.Fatalf("foreign-origin web login: %d", r.status)
	}
	if r := webPost(t, "/api/auth/login", login, map[string]string{"X-Client": "web", "Origin": "https://app.example.ru"}, ""); r.status != 200 {
		t.Fatalf("alt-domain web login: %d", r.status)
	}

	// Refresh from the cookie rotates it.
	r = webPost(t, "/api/auth/refresh", nil, goodOrigin, c.Value)
	var rr v1.RefreshResponse
	_ = protojson.Unmarshal(r.body, &rr)
	if r.status != 200 || r.cookie == nil || r.cookie.Value == c.Value || rr.GetTokens().GetRefreshToken() != "" {
		t.Fatalf("cookie refresh: %d %s", r.status, r.body)
	}
	c2 := r.cookie

	// Cookie request with a wrong Origin, with a cross-site fetch and with no origin info → 403.
	for name, hdr := range map[string]map[string]string{
		"evil origin": {"Origin": "https://evil.example.com"},
		"cross-site":  {"Sec-Fetch-Site": "cross-site"},
		"no origin":   {},
		"http scheme": {"Origin": "http://app.example.com"},
	} {
		if r := webPost(t, "/api/auth/refresh", nil, hdr, c2.Value); r.status != 403 {
			t.Errorf("refresh with %s: %d, want 403", name, r.status)
		}
	}
	// Same-origin fetch without Origin is fine.
	r = webPost(t, "/api/auth/refresh", nil, map[string]string{"Sec-Fetch-Site": "same-origin"}, c2.Value)
	if r.status != 200 {
		t.Fatalf("same-origin refresh: %d %s", r.status, r.body)
	}
	c3 := r.cookie
	// The access token works as a normal bearer; bearer requests are not origin-checked.
	var rr2 v1.RefreshResponse
	_ = protojson.Unmarshal(r.body, &rr2)
	(&client{t: t, token: rr2.GetTokens().GetAccessToken()}).must(200, "GET", "/api/me", nil, nil)

	// Logout by cookie (no access token): cookie cleared, session dead.
	if r := webPost(t, "/api/auth/logout", &v1.LogoutRequest{}, map[string]string{"Origin": "https://evil.example.com"}, c3.Value); r.status != 403 {
		t.Fatalf("cross-origin cookie logout: %d", r.status)
	}
	r = webPost(t, "/api/auth/logout", &v1.LogoutRequest{}, goodOrigin, c3.Value)
	if r.status != 204 || r.cookie == nil || r.cookie.MaxAge >= 0 {
		t.Fatalf("cookie logout: %d %+v", r.status, r.cookie)
	}
	if r := webPost(t, "/api/auth/refresh", nil, goodOrigin, c3.Value); r.status != 401 || r.cookie == nil || r.cookie.MaxAge >= 0 {
		t.Fatalf("refresh after logout: %d (cookie must be cleared)", r.status)
	}
	if r := webPost(t, "/api/auth/logout", &v1.LogoutRequest{}, nil, ""); r.status != 401 {
		t.Fatalf("anonymous logout: %d", r.status)
	}

	// Desktop behaviour unchanged: token in the body, no cookie, no origin check.
	r = webPost(t, "/api/auth/login", login, nil, "")
	var dl v1.LoginResponse
	_ = protojson.Unmarshal(r.body, &dl)
	if r.status != 200 || r.cookie != nil || dl.GetTokens().GetRefreshToken() == "" {
		t.Fatalf("desktop login changed: %d cookie=%v", r.status, r.cookie)
	}
	// Desktop logout by refresh token in the body.
	if r := webPost(t, "/api/auth/logout", &v1.LogoutRequest{RefreshToken: dl.GetTokens().GetRefreshToken()}, nil, ""); r.status != 204 {
		t.Fatalf("logout by body refresh token: %d %s", r.status, r.body)
	}
}

func TestGatewayOrigin(t *testing.T) {
	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/gateway?v=1&encoding=json"
	dial := func(origin string) (int, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		h := http.Header{}
		if origin != "" {
			h.Set("Origin", origin)
		}
		ws, resp, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: h})
		if resp != nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
		if ws != nil {
			_ = ws.CloseNow()
		}
		if resp == nil {
			return 0, err
		}
		return resp.StatusCode, err
	}
	for origin, want := range map[string]int{
		"https://app.example.com":  http.StatusSwitchingProtocols,
		"https://app.example.ru":   http.StatusSwitchingProtocols,
		"file://":                  http.StatusSwitchingProtocols,
		"":                         http.StatusSwitchingProtocols,
		"https://evil.example.com": http.StatusForbidden,
	} {
		if st, _ := dial(origin); st != want {
			t.Errorf("origin %q: status %d, want %d", origin, st, want)
		}
	}
}
