package sip

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"testing"

	"github.com/calaba/calaba/server/internal/rtc"
)

func TestNormalizeNumber(t *testing.T) {
	for in, want := range map[string]string{
		"+7 916 123-45-67":  "+79161234567",
		"8 (916) 123-45-67": "+79161234567",
		"79161234567":       "+79161234567",
		"0049 30 1234567":   "+49301234567",
		"+44 20 7946 0958":  "+442079460958",
		"+1.415.555.2671":   "+14155552671",
		" +7 495 1234567":   "+74951234567",
	} {
		if got, ok := NormalizeNumber(in); !ok || got != want {
			t.Errorf("%q → %q %v, want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{"", "916 123 45 67", "+0123456789", "+7916abc", "123", "+7 916 123-45-67 ext 5",
		"++79161234567", "7+9161234567", "+1234567890123456", "*100#", "sip:+79161234567"} {
		if got, ok := NormalizeNumber(in); ok {
			t.Errorf("%q accepted as %q", in, got)
		}
	}
}

func TestPrefixesAndDialString(t *testing.T) {
	if !Allowed("+79161234567", nil) || !Allowed("+79161234567", []string{"+44", "+7"}) || Allowed("+449161234567", []string{"+7"}) {
		t.Fatal("allowed prefixes")
	}
	if DialString("", "+79161234567") != "79161234567" || DialString("+", "+79161234567") != "+79161234567" || DialString("8", "+79161234567") != "879161234567" {
		t.Fatal("dial string")
	}
	for p, ok := range map[string]bool{"": true, "+": true, "8": true, "+810": true, "12345678": true, "123456789": false, "8+": false, "a": false} {
		if dialPrefixRe.MatchString(p) != ok {
			t.Errorf("dial prefix %q", p)
		}
	}
	for p, ok := range map[string]bool{"+7": true, "+7495": true, "7": false, "+": false, "+7-495": false} {
		if prefixRe.MatchString(p) != ok {
			t.Errorf("allowed prefix %q", p)
		}
	}
}

type fakeDNS map[string][]netip.Addr

func (f fakeDNS) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	if a, ok := f[host]; ok {
		return a, nil
	}
	return nil, errors.New("no such host")
}

func (f fakeDNS) LookupSRV(_ context.Context, service, proto, name string) (string, []*net.SRV, error) {
	if service == "sip" && proto == "udp" && name == "srv.example.com" {
		return "", []*net.SRV{{Target: "sip1.example.com.", Port: 5060}}, nil
	}
	return "", nil, errors.New("no such host")
}

func TestParseHost(t *testing.T) {
	dns := fakeDNS{
		"sip.example.com":  {netip.MustParseAddr("203.0.113.10")},
		"sip1.example.com": {netip.MustParseAddr("198.51.100.7")},
		"evil.example.com": {netip.MustParseAddr("127.0.0.1")},
		"lan.example.com":  {netip.MustParseAddr("203.0.113.9"), netip.MustParseAddr("10.0.0.5")},
	}
	ctx := context.Background()
	for in, want := range map[string]string{
		"sip.example.com":        "sip.example.com",
		"SIP.Example.com.:5061":  "sip.example.com:5061",
		"203.0.113.10":           "203.0.113.10",
		"203.0.113.10:5080":      "203.0.113.10:5080",
		"srv.example.com":        "srv.example.com",
		"[2001:4860::8888]:5060": "[2001:4860::8888]:5060",
	} {
		if got, err := ParseHost(ctx, dns, publicAddr, in, "udp"); err != nil || got != want {
			t.Errorf("%q → %q %v, want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "sip:sip.example.com", "user@sip.example.com", "sip.example.com:0", "sip.example.com:99999",
		"sip.example.com:", "127.0.0.1", "10.1.2.3:5060", "169.254.1.1", "100.64.0.1", "[::1]:5060", "evil.example.com",
		"lan.example.com", "nowhere.example.com", "localhost", "a b.example.com", "sip.example.com/x", "-bad.example.com"} {
		if got, err := ParseHost(ctx, dns, publicAddr, in, "udp"); err == nil {
			t.Errorf("%q accepted as %q", in, got)
		}
	}
	// The SRV fallback follows the transport: no _sip._tcp record → refused.
	if _, err := ParseHost(ctx, dns, publicAddr, "srv.example.com", "tcp"); err == nil {
		t.Error("tcp SRV")
	}
}

func TestFieldChecks(t *testing.T) {
	if !usernameOK("user-1_2.x") || usernameOK(`a"b`) || usernameOK("a b") || usernameOK("a\r\nb") || usernameOK(string(make([]byte, 129))) {
		t.Fatal("username")
	}
	if !passwordOK("пароль p@ss") || passwordOK("a\nb") || passwordOK(string(make([]byte, 257))) {
		t.Fatal("password")
	}
	if _, ok := cleanText("Zadarma", 64); !ok {
		t.Fatal("provider")
	}
	if _, ok := cleanText("a\x00b", 64); ok {
		t.Fatal("control characters")
	}
}

func TestFailureReason(t *testing.T) {
	for msg, want := range map[string]string{
		"sip status 486: Busy Here":           reasonBusy,
		"sip status 480: Unavailable":         reasonNoAnswer,
		"sip status 603: Decline":             reasonDeclined,
		"sip status 404: Not Found":           reasonInvalid,
		"sip status 407: Proxy Auth":          reasonAuth,
		"sip status 503: Service Unavailable": "error 503",
	} {
		if got := failureReason(&rtc.Error{Code: "unavailable", Msg: msg}); got != want {
			t.Errorf("%q → %q, want %q", msg, got, want)
		}
	}
	if failureReason(errors.New("dial tcp: connection refused")) != reasonUnavailable ||
		failureReason(&rtc.Error{Code: "unavailable", Msg: "no response from servers"}) != reasonUnavailable ||
		failureReason(context.DeadlineExceeded) != reasonNoAnswer ||
		failureReason(&rtc.Error{Code: "invalid_argument", Msg: "bad number"}) != reasonError {
		t.Fatal("non-SIP errors")
	}
}
