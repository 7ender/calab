package httpx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSameOrigin(t *testing.T) {
	allowed := []string{"https://app.example.com", "https://app.example.ru"}
	for _, c := range []struct {
		origin, site string
		want         bool
	}{
		{"https://app.example.com", "", true},
		{"HTTPS://APP.EXAMPLE.RU", "", true},
		{"https://evil.example.com", "same-origin", false}, // Origin wins
		{"https://app.example.com:8443", "", false},
		{"null", "", false},
		{"", "same-origin", true},
		{"", "cross-site", false},
		{"", "same-site", false},
		{"", "", false},
	} {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/refresh", nil)
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		if c.site != "" {
			r.Header.Set("Sec-Fetch-Site", c.site)
		}
		if got := SameOrigin(r, allowed); got != c.want {
			t.Errorf("origin=%q site=%q: got %v", c.origin, c.site, got)
		}
	}
}
