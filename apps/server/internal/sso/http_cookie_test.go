package sso

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/google/uuid"
)

// Any number of begun flows keeps a single bounded binding cookie: a begin loop cannot
// fill the cookie jar and evict the session cookies.
func TestSSOBrowserBindingCookieIsBounded(t *testing.T) {
	var jar *http.Cookie
	var flows []uuid.UUID
	secrets := map[uuid.UUID]string{}
	for range 10 {
		flow := uuid.New()
		secret, _ := identitycrypto.Secret()
		r := httptest.NewRequestWithContext(context.Background(), "GET", "/", nil)
		if jar != nil {
			r.AddCookie(jar)
		}
		w := httptest.NewRecorder()
		setBrowser(w, r, flow, secret)
		cookies := w.Result().Cookies()
		if len(cookies) != 1 || cookies[0].Name != browserCookieName || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode || cookies[0].Path != "/" {
			t.Fatalf("unsafe binding cookie %+v", cookies)
		}
		jar = cookies[0]
		flows = append(flows, flow)
		secrets[flow] = secret
	}
	if n := strings.Count(jar.Value, ".") + 1; n != browserCookieMax || len(jar.Value) > 512 {
		t.Fatalf("cookie holds %d entries, %d bytes", n, len(jar.Value))
	}
	r := httptest.NewRequestWithContext(context.Background(), "GET", "/", nil)
	r.AddCookie(jar)
	for i, flow := range flows {
		got := browserCookie(r, flow)
		if newest := i >= len(flows)-browserCookieMax; newest != (got == secrets[flow]) || !newest && got != "" {
			t.Fatalf("flow %d: binding %q", i, got)
		}
	}
	w := httptest.NewRecorder()
	dropBrowser(w, r, flows[len(flows)-1])
	r = httptest.NewRequestWithContext(context.Background(), "GET", "/", nil)
	r.AddCookie(w.Result().Cookies()[0])
	if browserCookie(r, flows[len(flows)-1]) != "" || browserCookie(r, flows[len(flows)-2]) != secrets[flows[len(flows)-2]] {
		t.Fatal("finish must drop only its own binding")
	}
	// Malformed entries never yield a binding.
	r = httptest.NewRequestWithContext(context.Background(), "GET", "/", nil)
	r.AddCookie(&http.Cookie{Name: browserCookieName, Value: flows[0].String() + ":short." + "not-a-uuid:" + secrets[flows[0]]})
	if len(browserBindings(r)) != 0 {
		t.Fatal("malformed binding accepted")
	}
}
