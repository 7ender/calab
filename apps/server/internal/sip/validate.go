package sip

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// e164 is a normalised phone number: «+», a non-zero digit, 7..15 digits in all.
var e164 = regexp.MustCompile(`^\+[1-9][0-9]{6,14}$`)

// NormalizeNumber turns what people type into E.164 (ADR-0046): spaces, dashes, dots and
// brackets go; «00» becomes «+»; a Russian national number of 11 digits starting with 8 or 7
// becomes +7…. Anything else must already start with «+». ok = false for anything that is not
// a phone number afterwards.
func NormalizeNumber(s string) (string, bool) {
	var b strings.Builder
	for i, r := range strings.TrimSpace(s) {
		switch {
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '+' && i == 0:
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '.' || r == '(' || r == ')' || r == ' ':
		default:
			return "", false
		}
	}
	n := b.String()
	switch {
	case strings.HasPrefix(n, "+"):
	case strings.HasPrefix(n, "00"):
		n = "+" + n[2:]
	case len(n) == 11 && (n[0] == '8' || n[0] == '7'):
		n = "+7" + n[1:]
	default:
		return "", false
	}
	return n, e164.MatchString(n)
}

// prefixRe: an allowed prefix, «+» and 1..15 digits.
var prefixRe = regexp.MustCompile(`^\+[0-9]{1,15}$`)

// dialPrefixRe: the outbound dial prefix, an optional «+» and up to 8 digits.
var dialPrefixRe = regexp.MustCompile(`^\+?[0-9]{0,8}$`)

// Allowed reports whether number (E.164) starts with one of prefixes; no prefixes = any.
func Allowed(number string, prefixes []string) bool {
	if len(prefixes) == 0 {
		return true
	}
	for _, p := range prefixes {
		if strings.HasPrefix(number, p) {
			return true
		}
	}
	return false
}

// DialString is what the provider gets as the INVITE user part: the dial prefix and the
// number's digits without «+» (ADR-0046).
func DialString(prefix, number string) string {
	return prefix + strings.TrimPrefix(number, "+")
}

// hostRe: a DNS name (labels of letters, digits and dashes).
var hostRe = regexp.MustCompile(`^(?i)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)

// Resolver is the DNS lookups host validation needs (net.DefaultResolver).
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
	LookupSRV(ctx context.Context, service, proto, name string) (string, []*net.SRV, error)
}

var errHost = errors.New("host must be a provider host name or public IP address with an optional :port, without «sip:»")

// ParseHost validates the provider address «host[:port]» (no scheme, no user part) and returns
// it in canonical form. Literal IPs must pass allow; names must resolve (A/AAAA, else the SIP SRV
// records of the transport) to addresses that all pass allow — LiveKit SIP sends signalling
// there from our host, so private and loopback targets are refused (SSRF).
func ParseHost(ctx context.Context, res Resolver, allow func(netip.Addr) bool, raw, transport string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 260 || strings.ContainsAny(raw, "@/;?# \t") || strings.Contains(strings.ToLower(raw), "sip:") {
		return "", errHost
	}
	host, port := raw, ""
	if h, p, err := net.SplitHostPort(raw); err == nil {
		host, port = h, p
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			return "", errHost
		}
	} else if strings.Count(raw, ":") == 1 {
		return "", errHost // «host:» or a bad port
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if a, err := netip.ParseAddr(host); err == nil {
		if a.Zone() != "" || !allow(a) {
			return "", errors.New("host must be a public address")
		}
	} else {
		if !hostRe.MatchString(host) || len(host) > 253 || !strings.Contains(host, ".") {
			return "", errHost
		}
		if err := checkResolved(ctx, res, allow, host, transport); err != nil {
			return "", err
		}
	}
	if port == "" {
		return host, nil
	}
	return net.JoinHostPort(host, port), nil
}

func checkResolved(ctx context.Context, res Resolver, allow func(netip.Addr) bool, host, transport string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addrs, err := res.LookupNetIP(ctx, "ip", host)
	if err != nil || len(addrs) == 0 {
		proto := "udp"
		if transport != "udp" {
			proto = "tcp"
		}
		svc := "sip"
		if transport == "tls" {
			svc = "sips"
		}
		_, srvs, serr := res.LookupSRV(ctx, svc, proto, host)
		if serr != nil || len(srvs) == 0 {
			return errors.New("host does not resolve")
		}
		for _, s := range srvs[:min(len(srvs), 5)] {
			as, err := res.LookupNetIP(ctx, "ip", strings.TrimSuffix(s.Target, "."))
			if err != nil {
				return errors.New("host does not resolve")
			}
			addrs = append(addrs, as...)
		}
	}
	if len(addrs) == 0 {
		return errors.New("host does not resolve")
	}
	for _, a := range addrs {
		if !allow(a) {
			return errors.New("host must be a public address")
		}
	}
	return nil
}

// cleanText checks a free text field: valid UTF-8, no control characters, at most n runes.
func cleanText(s string, n int) (string, bool) {
	s = strings.TrimSpace(s)
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > n {
		return "", false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return "", false
		}
	}
	return s, true
}

// usernameOK: a SIP login goes into a quoted Authorization header field — printable ASCII
// without quotes and backslashes.
func usernameOK(s string) bool {
	if len(s) > 128 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; c < 0x21 || c > 0x7e || c == '"' || c == '\\' {
			return false
		}
	}
	return true
}

// passwordOK: at most 256 bytes of UTF-8 without control characters.
func passwordOK(s string) bool {
	if len(s) > 256 || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
