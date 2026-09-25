// Package unfurl builds link previews (OpenGraph / Twitter cards) and proxies their images,
// with SSRF protection: only http(s), only public IP addresses (checked at connect time,
// after DNS resolution, so DNS rebinding cannot bypass it), at most 3 redirects, strict
// timeouts and size limits, no environment proxies.
package unfurl

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"
)

// Limits.
const (
	maxRedirects = 3
	maxURLLen    = 2048
	userAgent    = "Mozilla/5.0 (compatible; CalabaBot/1.0; link preview)"
)

// ErrBlocked is returned for URLs or addresses the fetcher refuses.
var ErrBlocked = errors.New("unfurl: address not allowed")

// Ranges that are not public beyond what netip classifies (IsPrivate, IsLoopback, ...).
var blocked = func() []netip.Prefix {
	var out []netip.Prefix
	for _, s := range []string{
		"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15",
		"198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "255.255.255.255/32",
		"64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001:db8::/32", "2002::/16", "2001::/32",
	} {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}()

// PublicAddr reports whether an IP address is globally routable (safe to fetch from).
func PublicAddr(a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsValid() || a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() ||
		a.IsInterfaceLocalMulticast() || a.IsMulticast() || a.IsUnspecified() {
		return false
	}
	for _, p := range blocked {
		if p.Contains(a) {
			return false
		}
	}
	return true
}

// PublicOrAllowed extends PublicAddr with explicitly allowed ranges (UNFURL_ALLOW_CIDRS).
// Loopback, link-local and unspecified addresses are never allowed.
func PublicOrAllowed(extra []netip.Prefix) func(netip.Addr) bool {
	return func(a netip.Addr) bool {
		a = a.Unmap()
		if PublicAddr(a) {
			return true
		}
		if a.IsLoopback() || a.IsLinkLocalUnicast() || a.IsUnspecified() {
			return false
		}
		for _, p := range extra {
			if p.Contains(a) {
				return true
			}
		}
		return false
	}
}

// CheckURL validates a user-supplied URL: absolute http(s), no credentials, sane length.
func CheckURL(raw string) (*url.URL, error) {
	if len(raw) == 0 || len(raw) > maxURLLen {
		return nil, fmt.Errorf("%w: bad length", ErrBlocked)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBlocked, err)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return nil, fmt.Errorf("%w: only http(s) URLs without credentials", ErrBlocked)
	}
	u.Fragment, u.RawFragment = "", ""
	return u, nil
}

// newClient builds the SSRF-safe HTTP client. allow decides which resolved addresses may
// be dialed (PublicAddr in production; tests may allow loopback).
func newClient(timeout time.Duration, allow func(netip.Addr) bool) *http.Client {
	dialer := &net.Dialer{
		Timeout: timeout,
		Control: func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			a, err := netip.ParseAddr(host)
			if err != nil || !allow(a) {
				return fmt.Errorf("%w: %s", ErrBlocked, host)
			}
			return nil
		},
	}
	tr := &http.Transport{
		Proxy:                 nil, // never follow HTTP(S)_PROXY for user-supplied URLs
		DialContext:           dialer.DialContext,
		TLSHandshakeTimeout:   timeout,
		ResponseHeaderTimeout: timeout,
		MaxIdleConns:          16,
		IdleConnTimeout:       30 * time.Second,
		ForceAttemptHTTP2:     true,
	}
	return &http.Client{
		Transport: tr,
		Timeout:   timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > maxRedirects {
				return fmt.Errorf("%w: too many redirects", ErrBlocked)
			}
			_, err := CheckURL(req.URL.String())
			return err
		},
	}
}

// get performs a GET with browser-ish headers.
func get(ctx context.Context, c *http.Client, u string, accept string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil) //nolint:gosec // G704: see Do below
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", accept)
	req.Header.Set("Accept-Language", "ru,en;q=0.8")
	return c.Do(req) //nolint:gosec // G704: SSRF handled by CheckURL + dialer Control (public addresses only)
}

func isHTML(ct string) bool {
	ct = strings.ToLower(ct)
	return strings.HasPrefix(ct, "text/html") || strings.HasPrefix(ct, "application/xhtml+xml")
}
