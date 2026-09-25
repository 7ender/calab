package httpx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestClientIP(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32"), netip.MustParsePrefix("10.0.0.0/8")}
	cases := []struct {
		name, remote, xff, want string
	}{
		{"direct, no xff", "203.0.113.5:1234", "", "203.0.113.5"},
		{"untrusted peer spoofs xff", "203.0.113.5:1234", "1.2.3.4", "203.0.113.5"},
		{"trusted proxy", "127.0.0.1:1234", "198.51.100.7", "198.51.100.7"},
		{"client-supplied prefix ignored", "127.0.0.1:1234", "1.2.3.4, 198.51.100.7", "198.51.100.7"},
		{"chain of trusted proxies", "127.0.0.1:1234", "198.51.100.7, 10.1.2.3", "198.51.100.7"},
		{"garbage xff", "127.0.0.1:1234", "nonsense", "127.0.0.1"},
		{"ipv6 peer", "[2001:db8::1]:443", "", "2001:db8::1"},
	}
	for _, c := range cases {
		var got string
		h := WithClientIP(trusted)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { got = ClientIP(r.Context()) }))
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil)
		req.RemoteAddr = c.remote
		if c.xff != "" {
			req.Header.Set("X-Forwarded-For", c.xff)
		}
		h.ServeHTTP(httptest.NewRecorder(), req)
		if got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestWriteErrorMapsStatus(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteError(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil), Validation("slug", "bad"))
	if rec.Code != http.StatusUnprocessableEntity || rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("status %d", rec.Code)
	}
	if body := rec.Body.String(); body != `{"code":"ERROR_CODE_VALIDATION","message":"bad","field":"slug"}` &&
		body != `{"code":"ERROR_CODE_VALIDATION", "message":"bad", "field":"slug"}` {
		t.Fatalf("body %s", body)
	}
	rec = httptest.NewRecorder()
	WriteError(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil), http.ErrBodyNotAllowed)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("unknown error mapped to %d", rec.Code)
	}
}
