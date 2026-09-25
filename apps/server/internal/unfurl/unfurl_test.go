package unfurl

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"

	"golang.org/x/text/encoding/charmap"
)

func TestPublicAddr(t *testing.T) {
	for s, want := range map[string]bool{
		"8.8.8.8": true, "2a00:1450:4001::1": true, "93.184.216.34": true,
		"127.0.0.1": false, "10.1.2.3": false, "172.16.0.1": false, "192.168.1.1": false, "169.254.169.254": false,
		"100.64.0.1": false, "0.0.0.0": false, "::1": false, "fe80::1": false, "fd00::1": false, "::ffff:127.0.0.1": false,
		"64:ff9b::7f00:1": false, "2002:7f00:1::": false, "224.0.0.1": false, "255.255.255.255": false,
	} {
		if got := PublicAddr(netip.MustParseAddr(s)); got != want {
			t.Errorf("%s: got %v want %v", s, got, want)
		}
	}
}

func TestCheckURL(t *testing.T) {
	for _, ok := range []string{"https://example.com/a?b=1#frag", "http://example.com:8080/"} {
		u, err := CheckURL(ok)
		if err != nil || u.Fragment != "" {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "ftp://x", "file:///etc/passwd", "https://user:pw@example.com/", "//example.com", "javascript:alert(1)", "https://" + strings.Repeat("a", 3000)} {
		if _, err := CheckURL(bad); !errors.Is(err, ErrBlocked) {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestParse(t *testing.T) {
	base, _ := url.Parse("https://news.example.ru/a/b")
	page := `<html><head><meta charset="windows-1251"><title>Заголовок страницы</title>
<meta property="og:title" content="Новость дня"><meta name="description" content="Описание">
<meta property="og:image" content="/img/cover.jpg"><meta property="og:url" content="https://evil.example.com/x">
<link rel="icon" href="//cdn.example.ru/fav.png"></head><body><meta property="og:title" content="ignored"></body></html>`
	enc, _ := charmap.Windows1251.NewEncoder().String(page)
	c := Parse(strings.NewReader(enc), "text/html", base)
	if c.Title != "Новость дня" || c.Description != "Описание" || c.SiteName != "news.example.ru" ||
		c.Image != "https://news.example.ru/img/cover.jpg" || c.Favicon != "https://cdn.example.ru/fav.png" || c.URL != base.String() {
		t.Fatalf("%+v", c)
	}
	c = Parse(strings.NewReader(`<head><title> Only  title </title></head>`), "text/html; charset=utf-8", base)
	if c.Title != "Only title" || c.Favicon != "https://news.example.ru/favicon.ico" || c.Image != "" {
		t.Fatalf("%+v", c)
	}
	c = Parse(strings.NewReader(`<head><meta property="og:image" content="javascript:alert(1)"><title>x</title></head>`), "text/html", base)
	if c.Image != "" {
		t.Fatal("non-http image accepted")
	}
}

func testService(allow func(netip.Addr) bool) *Service {
	return &Service{page: newClient(pageTimeout, allow), img: newClient(imageTimeout, allow), key: []byte("k")}
}

func TestFetchSSRFAndLimits(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/page":
			w.Header().Set("Content-Type", "text/html")
			_, _ = fmt.Fprint(w, `<head><title>Hello</title></head>`)
		case "/json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprint(w, `{}`)
		default: // /r/N redirects N more times
			var n int
			_, _ = fmt.Sscanf(r.URL.Path, "/r/%d", &n)
			if n == 0 {
				http.Redirect(w, r, "/page", http.StatusFound)
				return
			}
			http.Redirect(w, r, fmt.Sprintf("/r/%d", n-1), http.StatusFound)
		}
	}))
	defer srv.Close()
	u := func(p string) *url.URL { x, _ := url.Parse(srv.URL + p); return x }
	ctx := context.Background()

	// Production policy: the loopback test server is unreachable.
	if _, err := testService(PublicAddr).fetch(ctx, u("/page")); !errors.Is(err, ErrBlocked) {
		t.Fatalf("loopback fetched: %v", err)
	}
	all := testService(func(netip.Addr) bool { return true })
	if c, err := all.fetch(ctx, u("/page")); err != nil || c.Title != "Hello" {
		t.Fatalf("allowed fetch: %+v %v", c, err)
	}
	if _, err := all.fetch(ctx, u("/json")); err == nil {
		t.Fatal("non-HTML accepted")
	}
	if _, err := all.fetch(ctx, u("/r/1")); err != nil { // 2 redirects
		t.Fatalf("2 redirects: %v", err)
	}
	if _, err := all.fetch(ctx, u("/r/5")); !errors.Is(err, ErrBlocked) {
		t.Fatalf("6 redirects: %v", err)
	}
}

func TestImageSignature(t *testing.T) {
	s := testService(PublicAddr)
	p := s.proxied("https://example.com/a.png")
	q, _ := url.ParseQuery(strings.TrimPrefix(p, "/api/unfurl/image?"))
	if q.Get("url") != "https://example.com/a.png" || q.Get("sig") != s.sign("https://example.com/a.png") || s.sign("https://example.com/b.png") == q.Get("sig") {
		t.Fatalf("proxied: %s", p)
	}
	if s.proxied("") != "" {
		t.Fatal("empty URL proxied")
	}
}

func TestPublicOrAllowed(t *testing.T) {
	f := PublicOrAllowed([]netip.Prefix{netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("127.0.0.0/8")})
	for s, want := range map[string]bool{"198.18.0.15": true, "8.8.8.8": true, "10.0.0.1": false, "127.0.0.1": false, "169.254.169.254": false} {
		if got := f(netip.MustParseAddr(s)); got != want {
			t.Errorf("%s: got %v want %v", s, got, want)
		}
	}
}
