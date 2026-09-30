package workspaces

import (
	"errors"
	"net"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxAppURLLen bounds a web app address (ADR-0050 §1), in characters.
const MaxAppURLLen = 2048

var errAppURL = errors.New("https:// address, or http:// to a private host (localhost, 10/8, 172.16/12, 192.168/16, *.local, a name without a dot)")

// ValidateAppURL checks the address of a web app (ADR-0050 §1) and returns it trimmed:
// https:// to any host, or http:// only to a private one (localhost, 127/8, [::1], 10/8,
// 172.16/12, 192.168/16, *.local, a single label without a dot) — an intranet. No
// user:password@, no whitespace, control characters or backslashes, a syntactically valid host
// and port. The server never fetches it (no SSRF: the client loads the page).
//
// The desktop client runs the same rule (apps/desktop/src/shared/appUrl.ts); both are tested
// against proto/testdata/app_urls.json. It parses by hand, not with net/url, so that the two
// implementations agree character by character.
func ValidateAppURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" || utf8.RuneCountInString(s) > MaxAppURLLen || !utf8.ValidString(s) {
		return "", errAppURL
	}
	for _, r := range s {
		if r <= ' ' || r == 0x7f || r == '\\' || r == 0xfeff || unicode.IsSpace(r) || unicode.IsControl(r) {
			return "", errAppURL
		}
	}
	scheme, rest, ok := strings.Cut(s, "://")
	if !ok {
		return "", errAppURL
	}
	var secure bool
	switch strings.ToLower(scheme) {
	case "https":
		secure = true
	case "http":
	default:
		return "", errAppURL
	}
	authority := rest
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		authority = rest[:i]
	}
	if authority == "" || strings.ContainsRune(authority, '@') {
		return "", errAppURL
	}
	host, port := authority, ""
	if strings.HasPrefix(authority, "[") {
		end := strings.IndexByte(authority, ']')
		if end < 0 {
			return "", errAppURL
		}
		host, port = authority[:end+1], authority[end+1:]
		if port != "" {
			if !strings.HasPrefix(port, ":") {
				return "", errAppURL
			}
			port = port[1:]
			if port == "" {
				return "", errAppURL
			}
		}
	} else if i := strings.LastIndexByte(authority, ':'); i >= 0 {
		host, port = authority[:i], authority[i+1:]
		if port == "" {
			return "", errAppURL
		}
	}
	if port != "" && !validPort(port) {
		return "", errAppURL
	}
	private, ok := appHost(strings.ToLower(host))
	if !ok || (!secure && !private) {
		return "", errAppURL
	}
	return s, nil
}

func validPort(p string) bool {
	if len(p) > 5 {
		return false
	}
	for _, c := range p {
		if c < '0' || c > '9' {
			return false
		}
	}
	n, err := strconv.Atoi(p)
	return err == nil && n >= 1 && n <= 65535
}

// appHost reports whether host (lower case) is syntactically valid, and whether it is private.
func appHost(host string) (private, ok bool) {
	if strings.HasPrefix(host, "[") {
		inner := strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
		ip := net.ParseIP(inner)
		if ip == nil || ip.To4() != nil || !strings.Contains(inner, ":") {
			return false, false
		}
		return ip.IsLoopback(), true
	}
	name := strings.TrimSuffix(host, ".")
	if name == "" || utf8.RuneCountInString(name) > 253 {
		return false, false
	}
	labels := strings.Split(name, ".")
	for _, l := range labels {
		if !validLabel(l) {
			return false, false
		}
	}
	// A numeric last label makes the whole host an IPv4 address to a browser (WHATWG URL:
	// "10.1", "0x7f.1", "010.0.0.1" …): only the canonical dotted quad is accepted.
	last := labels[len(labels)-1]
	if isDigits(last) || strings.HasPrefix(last, "0x") {
		ip, ok := dottedQuad(labels)
		if !ok {
			return false, false
		}
		return ip[0] == 10 || ip[0] == 127 || (ip[0] == 172 && ip[1]&0xf0 == 16) || (ip[0] == 192 && ip[1] == 168), true
	}
	switch {
	case len(labels) == 1:
		return true, true // "intranet", "localhost"
	case last == "localhost", last == "local":
		return true, true
	}
	return false, true
}

func validLabel(l string) bool {
	if l == "" || utf8.RuneCountInString(l) > 63 || strings.HasPrefix(l, "-") || strings.HasSuffix(l, "-") {
		return false
	}
	for _, r := range l {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
		case r >= 0x80 && (unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r)):
		default:
			return false
		}
	}
	return true
}

func isDigits(s string) bool {
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return s != ""
}

func dottedQuad(labels []string) ([4]int, bool) {
	var ip [4]int
	if len(labels) != 4 {
		return ip, false
	}
	for i, l := range labels {
		if !isDigits(l) || len(l) > 3 || (len(l) > 1 && l[0] == '0') {
			return ip, false
		}
		n, _ := strconv.Atoi(l)
		if n > 255 {
			return ip, false
		}
		ip[i] = n
	}
	return ip, true
}
