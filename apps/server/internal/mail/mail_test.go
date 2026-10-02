package mail

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net"
	netmail "net/mail"
	"net/textproto"
	"strings"
	"testing"
	"time"
)

func params() Params {
	return Params{"code": "042917", "minutes": "10", "workspace": "Team <b>", "inviter": "Ann", "days": "7",
		"url":   "https://app.example.com/join/AbCdEf2345",
		"title": "Standup", "date": "2026-10-05", "when": "2026-10-05 10:00–10:30", "organizer": "Ann"}
}

// Every template in every locale: subject, the action (code or link) in text and HTML, the
// attribution footer with its link, and no leftover placeholders.
func TestTemplatesAllLocales(t *testing.T) {
	for _, tmpl := range Templates() {
		for _, loc := range Locales() {
			m, err := Render(tmpl, loc, params())
			if err != nil {
				t.Fatalf("%s/%s: %v", tmpl, loc, err)
			}
			action := "042917"
			if tmpl != TemplateVerifyCode && tmpl != TemplatePasswordReset {
				action = "https://app.example.com/join/AbCdEf2345"
			}
			for part, body := range map[string]string{"text": m.Text, "html": m.HTML} {
				if !strings.Contains(body, action) {
					t.Errorf("%s/%s %s: no %q", tmpl, loc, part, action)
				}
				if !strings.Contains(body, "https://gptunnel.ai") || !strings.Contains(body, "Powered by GPTunneL") {
					t.Errorf("%s/%s %s: no attribution", tmpl, loc, part)
				}
				if !strings.Contains(body, "https://calab.io") {
					t.Errorf("%s/%s %s: no product link", tmpl, loc, part)
				}
				if strings.Contains(body, "{{") || strings.Contains(body, "<no value>") {
					t.Errorf("%s/%s %s: unexpanded placeholder", tmpl, loc, part)
				}
			}
			if m.Subject == "" || strings.ContainsAny(m.Subject, "\r\n") {
				t.Errorf("%s/%s: subject %q", tmpl, loc, m.Subject)
			}
			if strings.Contains(m.HTML, "Team <b>") {
				t.Errorf("%s/%s: workspace name not escaped in HTML", tmpl, loc)
			}
			if !strings.Contains(m.HTML, `lang="`+loc+`"`) || !strings.Contains(m.HTML, "prefers-color-scheme: dark") {
				t.Errorf("%s/%s: html wrapper", tmpl, loc)
			}
		}
	}
	// Codes go into the subject (owner: "Код подтверждения: 123456").
	if m, _ := Render(TemplateVerifyCode, "ru", params()); m.Subject != "Код подтверждения: 042917" {
		t.Errorf("ru subject %q", m.Subject)
	}
}

// Invitation (docs/09 #36): three numbered steps and the code as text in every locale; an
// invitation queued before the code param existed still renders, without the code block.
func TestWorkspaceInviteStepsAndCode(t *testing.T) {
	labels := map[string]string{LocaleEN: "Invitation code: ", LocaleRU: "Код приглашения: ", LocaleES: "Código de invitación: ", LocaleZhCN: "邀请码: "}
	for _, loc := range Locales() {
		m, err := Render(TemplateWorkspaceInvite, loc, params())
		if err != nil {
			t.Fatal(err)
		}
		for _, n := range []string{"\n1. ", "\n2. ", "\n3. "} {
			if !strings.Contains(m.Text, n) {
				t.Errorf("%s text: no step %q", loc, n)
			}
		}
		if strings.Count(m.HTML, "<li ") != 3 {
			t.Errorf("%s html: want 3 steps", loc)
		}
		if !strings.Contains(m.Text, labels[loc]+"042917") || !strings.Contains(m.HTML, "042917</span>") {
			t.Errorf("%s: no invitation code as text", loc)
		}
		p := params()
		delete(p, "code")
		old, err := Render(TemplateWorkspaceInvite, loc, p)
		if err != nil || strings.Contains(old.Text, labels[loc]) {
			t.Errorf("%s without code: %v", loc, err)
		}
	}
}

func TestRenderRejectsMissingParams(t *testing.T) {
	_, err := Render(TemplateWorkspaceInvite, "en", Params{"workspace": "x", "inviter": "y", "days": "7"})
	var pe *PermanentError
	if !errors.As(err, &pe) {
		t.Fatalf("missing url: %v", err)
	}
	if _, err := Render("nope", "en", nil); !errors.As(err, &pe) {
		t.Fatalf("unknown template: %v", err)
	}
	// Header injection through a user-controlled name is neutralized.
	m, err := Render(TemplateWorkspaceInvite, "en", Params{"workspace": "A\r\nBcc: x@evil", "inviter": "y", "days": "7", "url": "https://a/b"})
	if err != nil || strings.ContainsAny(m.Subject, "\r\n") {
		t.Fatalf("subject %q, %v", m.Subject, err)
	}
}

func TestLocale(t *testing.T) {
	for in, want := range map[string]string{
		"ru-RU": "ru", "RU": "ru", "en_US": "en", "es-419": "es", "zh": "zh-CN", "zh-Hans-CN": "zh-CN", "zh-TW": "zh-CN",
		"de": "", "": "",
	} {
		if got := Supported(in); got != want {
			t.Errorf("Supported(%q) = %q, want %q", in, got, want)
		}
	}
	if Locale("de") != "en" {
		t.Error("fallback")
	}
	for in, want := range map[string]string{
		"de-DE,de;q=0.9,ru;q=0.8,en;q=0.7": "ru",
		"fr, en;q=0.1, es;q=0.5":           "es",
		"zh-CN,zh;q=0.9":                   "zh-CN",
		"de":                               "",
		"*":                                "",
		"en;q=0, ru;q=0.2":                 "ru",
		"":                                 "",
	} {
		if got := FromAcceptLanguage(in); got != want {
			t.Errorf("FromAcceptLanguage(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBackoff(t *testing.T) {
	want := []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 16 * time.Minute, 32 * time.Minute, time.Hour, time.Hour}
	for i, w := range want {
		if got := Backoff(int32(i)); got != w { //nolint:gosec // small
			t.Errorf("Backoff(%d) = %v, want %v", i, got, w)
		}
	}
	// 24 h of retries: the schedule stays exponential, then hourly — ~29 attempts.
	var total time.Duration
	n := int32(0)
	for total < MaxRetry {
		total += Backoff(n)
		n++
	}
	if n < 20 || n > 40 {
		t.Errorf("%d attempts in 24 h", n)
	}
}

func TestSealRoundTrip(t *testing.T) {
	s := New(Config{Secret: []byte("secret-secret-secret-secret-secret")}, nil, nil, nil)
	b, err := s.seal(Params{"code": "123456"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "123456") {
		t.Fatal("params stored in clear")
	}
	p, err := s.open(b)
	if err != nil || p["code"] != "123456" {
		t.Fatalf("%v %v", p, err)
	}
	other := New(Config{Secret: []byte("another-secret-another-secret-xx")}, nil, nil, nil)
	if _, err := other.open(b); err == nil {
		t.Fatal("opened with a different secret")
	}
	if s.Enabled() {
		t.Fatal("no sender = disabled")
	}
}

func TestNewSMTPDefaults(t *testing.T) {
	for _, c := range []struct {
		host, tls string
		port      int
		wantHost  string
		wantPort  int
	}{
		{"mail.example.com", "tls", 0, "mail.example.com", 465},
		{"mail.example.com", "starttls", 0, "mail.example.com", 587},
		{"localhost:1025", "none", 0, "localhost", 1025},
		{"localhost:1025", "none", 2525, "localhost", 2525},
	} {
		s, err := NewSMTP(c.host, c.port, "", "", c.tls, "Calab <noreply@example.com>")
		if err != nil || s.Host != c.wantHost || s.Port != c.wantPort {
			t.Errorf("%+v: %+v %v", c, s, err)
		}
	}
	if _, err := NewSMTP("h", 0, "", "", "ssl", "a@b.c"); err == nil {
		t.Error("bad tls mode accepted")
	}
	if _, err := NewSMTP("h", 0, "", "", "tls", "not an address"); err == nil {
		t.Error("bad from accepted")
	}
}

// fakeSMTP is a minimal SMTP server (no TLS, no AUTH) that captures one message.
func fakeSMTP(t *testing.T) (addr string, got <-chan string) {
	t.Helper()
	var lc net.ListenConfig
	ln, err := lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	ch := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		tp := textproto.NewConn(conn)
		_ = tp.PrintfLine("220 fake ESMTP")
		for {
			line, err := tp.ReadLine()
			if err != nil {
				return
			}
			cmd := strings.ToUpper(strings.SplitN(line, " ", 2)[0])
			switch cmd {
			case "EHLO", "HELO":
				_ = tp.PrintfLine("250-fake")
				_ = tp.PrintfLine("250 8BITMIME")
			case "MAIL", "RCPT", "RSET", "NOOP":
				_ = tp.PrintfLine("250 ok")
			case "DATA":
				_ = tp.PrintfLine("354 go ahead")
				b, err := io.ReadAll(tp.DotReader())
				if err != nil {
					return
				}
				ch <- string(b)
				_ = tp.PrintfLine("250 queued")
			case "QUIT":
				_ = tp.PrintfLine("221 bye")
				return
			default:
				_ = tp.PrintfLine("502 unknown")
			}
		}
	}()
	return ln.Addr().String(), ch
}

func TestSMTPSendNone(t *testing.T) {
	addr, got := fakeSMTP(t)
	s, err := NewSMTP(addr, 0, "", "", TLSNone, "Calab <noreply@calab.example>")
	if err != nil {
		t.Fatal(err)
	}
	m, err := Render(TemplateVerifyCode, "ru", Params{"code": "123456", "minutes": "10"})
	if err != nil {
		t.Fatal(err)
	}
	m.To = "user@example.com"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Send(ctx, m); err != nil {
		t.Fatal(err)
	}
	raw := <-got
	msg, err := netmail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	subj, _ := new(mime.WordDecoder).DecodeHeader(msg.Header.Get("Subject"))
	if subj != "Код подтверждения: 123456" || msg.Header.Get("To") != "<user@example.com>" ||
		!strings.Contains(msg.Header.Get("From"), "noreply@calab.example") || msg.Header.Get("Message-Id") == "" {
		t.Fatalf("headers: %v (subject %q)", msg.Header, subj)
	}
	_, mp, _ := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	r := multipart.NewReader(msg.Body, mp["boundary"])
	var parts []string
	for {
		p, err := r.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(base64.NewDecoder(base64.StdEncoding, p))
		parts = append(parts, p.Header.Get("Content-Type")+"\n"+string(body))
	}
	if len(parts) != 2 || !strings.HasPrefix(parts[0], "text/plain") || !strings.Contains(parts[0], "123456") ||
		!strings.HasPrefix(parts[1], "text/html") || !strings.Contains(parts[1], "gptunnel.ai") {
		t.Fatalf("parts: %q", parts)
	}
}

func TestSMTPStartTLSRequired(t *testing.T) {
	addr, _ := fakeSMTP(t) // offers no STARTTLS
	s, _ := NewSMTP(addr, 0, "", "", TLSStartTLS, "a@b.example")
	err := s.Send(context.Background(), Message{To: "u@example.com", Subject: "x", Text: "x", HTML: "x"})
	if !isPermanent(err) {
		t.Fatalf("want a permanent error without STARTTLS, got %v", err)
	}
	if !isPermanent(&textproto.Error{Code: 550, Msg: "no such user"}) || isPermanent(&textproto.Error{Code: 451, Msg: "try later"}) {
		t.Fatal("5xx permanent, 4xx transient")
	}
}

func TestFake(t *testing.T) {
	f := NewFake()
	f.FailNext(1, errors.New("down"))
	if err := f.Send(context.Background(), Message{To: "a@b"}); err == nil {
		t.Fatal("FailNext")
	}
	go func() { _ = f.Send(context.Background(), Message{To: "a@b", Subject: "1"}) }()
	if m, ok := f.Wait(time.Second, func(m Message) bool { return m.To == "a@b" }); !ok || m.Subject != "1" {
		t.Fatal("Wait")
	}
	if _, ok := f.WaitN(10*time.Millisecond, 2, func(Message) bool { return true }); ok {
		t.Fatal("WaitN found a second message")
	}
}
