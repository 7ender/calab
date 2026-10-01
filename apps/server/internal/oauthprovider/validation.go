package oauthprovider

import (
	"encoding/base64"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

func scopeSet(raw string) ([]string, bool) {
	scopes := strings.Fields(raw)
	if len(scopes) == 0 || len(scopes) > 3 || !slices.Contains(scopes, "openid") {
		return nil, false
	}
	seen := map[string]bool{}
	for _, scope := range scopes {
		if !slices.Contains([]string{"openid", "profile", "email"}, scope) || seen[scope] {
			return nil, false
		}
		seen[scope] = true
	}
	slices.Sort(scopes)
	return scopes, true
}

func validChallenge(raw string) bool {
	b, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	return len(raw) == 43 && err == nil && len(b) == 32
}
func validVerifier(raw string) bool {
	if len(raw) < 43 || len(raw) > 128 {
		return false
	}
	for _, r := range raw {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-._~", r) {
			continue
		}
		return false
	}
	return true
}

func parseRedirect(raw, kind string) (*url.URL, bool) {
	if len(raw) == 0 || len(raw) > 2048 || strings.ContainsAny(raw, "\r\n\t ") || strings.Contains(raw, "#") || strings.Contains(raw, "*") {
		return nil, false
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || u.Scheme == "" {
		return nil, false
	}
	if u.Scheme == "https" && u.Host != "" {
		return u, true
	}
	if kind != "public_native" {
		return nil, false
	}
	if u.Scheme == "http" && loopback(u) {
		return u, true
	}
	// Reverse-domain private schemes require administrative registration and PKCE.
	if strings.Contains(u.Scheme, ".") && u.Scheme != "http" && u.Scheme != "https" && u.Path != "" {
		return u, true
	}
	return nil, false
}
func loopback(u *url.URL) bool {
	if u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" {
		return false
	}
	if net.ParseIP(u.Hostname()) == nil {
		return false
	}
	if u.Port() != "" {
		p, err := strconv.Atoi(u.Port())
		if err != nil || p < 1 || p > 65535 {
			return false
		}
	}
	return true
}
func redirectMatches(raw, registered, kind string) bool {
	u, ok := parseRedirect(raw, kind)
	if !ok {
		return false
	}
	r, ok := parseRedirect(registered, kind)
	if !ok {
		return false
	}
	if raw == registered {
		return true
	}
	if kind != "public_native" || u.Scheme != "http" || r.Scheme != "http" || !loopback(u) || !loopback(r) || u.Hostname() != r.Hostname() {
		return false
	}
	// Strip only the literal loopback port; every other byte remains exact.
	u.Host = r.Host
	return u.String() == registered
}
func validOrigin(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.Path == "" && u.RawQuery == "" && !u.ForceQuery && !strings.ContainsAny(raw, "#*\r\n\t ")
}
