package mail

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"time"
)

// TLS modes (SMTP_TLS).
const (
	TLSStartTLS = "starttls" // plain connect, then STARTTLS (required); port 587
	TLSImplicit = "tls"      // TLS from the first byte ("SMTPS"); port 465
	TLSNone     = "none"     // no encryption: local relays and Mailpit only
)

// SMTP delivers mail through one SMTP server (net/smtp).
type SMTP struct {
	Host     string
	Port     int
	User     string // empty = no AUTH
	Password string
	TLS      string
	From     *mail.Address
}

// NewSMTP validates the settings. port 0 = the default of the TLS mode.
func NewSMTP(host string, port int, user, password, tlsMode, from string) (*SMTP, error) {
	if h, p, err := net.SplitHostPort(host); err == nil { // SMTP_HOST=localhost:1025
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil, fmt.Errorf("SMTP_HOST: bad port %q", p)
		}
		host = h
		if port == 0 {
			port = n
		}
	}
	if tlsMode == "" {
		tlsMode = TLSStartTLS
	}
	if port == 0 {
		port = map[string]int{TLSStartTLS: 587, TLSImplicit: 465, TLSNone: 25}[tlsMode]
	}
	if port == 0 {
		return nil, fmt.Errorf("SMTP_TLS must be starttls, tls or none, got %q", tlsMode)
	}
	if host == "" {
		return nil, errors.New("SMTP_HOST is empty")
	}
	addr, err := mail.ParseAddress(from)
	if err != nil {
		return nil, fmt.Errorf("SMTP_FROM: %w", err)
	}
	return &SMTP{Host: host, Port: port, User: user, Password: password, TLS: tlsMode, From: addr}, nil
}

// Send implements Sender.
func (s *SMTP) Send(ctx context.Context, m Message) error {
	raw, err := buildMIME(s.From, m, time.Now())
	if err != nil {
		return &PermanentError{err}
	}
	addr := net.JoinHostPort(s.Host, strconv.Itoa(s.Port))
	tcfg := &tls.Config{ServerName: s.Host, MinVersion: tls.VersionTLS12}
	var conn net.Conn
	if s.TLS == TLSImplicit {
		d := tls.Dialer{Config: tcfg}
		conn, err = d.DialContext(ctx, "tcp", addr)
	} else {
		var d net.Dialer
		conn, err = d.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("smtp dial %s: %w", addr, err)
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(30 * time.Second)
	}
	_ = conn.SetDeadline(deadline)
	c, err := smtp.NewClient(conn, s.Host)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("smtp greeting: %w", err)
	}
	defer func() { _ = c.Close() }()
	if s.TLS == TLSStartTLS {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return &PermanentError{errors.New("smtp: server does not offer STARTTLS (set SMTP_TLS)")}
		}
		if err := c.StartTLS(tcfg); err != nil {
			return fmt.Errorf("smtp starttls: %w", err)
		}
	}
	if s.User != "" {
		// PlainAuth refuses to send the password over an unencrypted connection (except to
		// localhost), so SMTP_TLS=none with a remote server fails here instead of leaking it.
		if err := c.Auth(smtp.PlainAuth("", s.User, s.Password, s.Host)); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := c.Mail(s.From.Address); err != nil {
		return fmt.Errorf("smtp MAIL FROM: %w", err)
	}
	if err := c.Rcpt(m.To); err != nil {
		return fmt.Errorf("smtp RCPT TO: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp DATA: %w", err)
	}
	if _, err := w.Write(raw); err != nil {
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp end of data: %w", err)
	}
	_ = c.Quit()
	return nil
}

// buildMIME renders a multipart/alternative message (text + HTML, base64 UTF-8).
func buildMIME(from *mail.Address, m Message, now time.Time) ([]byte, error) {
	to, err := mail.ParseAddress(m.To)
	if err != nil {
		return nil, fmt.Errorf("bad recipient: %w", err)
	}
	if strings.ContainsAny(m.Subject, "\r\n") {
		return nil, errors.New("subject contains a line break")
	}
	var id [12]byte
	_, _ = rand.Read(id[:])
	domain := from.Address[strings.LastIndexByte(from.Address, '@')+1:]

	parts := []struct{ ctype, content string }{
		{"text/plain; charset=utf-8", m.Text},
		{"text/html; charset=utf-8", m.HTML},
	}
	if m.Calendar != "" {
		// Inline text/calendar in the alternative makes Gmail / Outlook / Apple Mail show the
		// invitation; the attachment is for everything else (ADR-0038 §4).
		parts = append(parts, struct{ ctype, content string }{"text/calendar; charset=utf-8; method=" + m.CalendarMethod, m.Calendar})
	}
	var alt bytes.Buffer
	aw := multipart.NewWriter(&alt)
	for _, part := range parts {
		if err := writeBase64Part(aw, textproto.MIMEHeader{"Content-Type": {part.ctype}}, part.content); err != nil {
			return nil, err
		}
	}
	if err := aw.Close(); err != nil {
		return nil, err
	}
	body, ctype := alt.Bytes(), `multipart/alternative; boundary="`+aw.Boundary()+`"`
	if m.Calendar != "" {
		var mixed bytes.Buffer
		mw := multipart.NewWriter(&mixed)
		w, err := mw.CreatePart(textproto.MIMEHeader{"Content-Type": {ctype}})
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(body); err != nil {
			return nil, err
		}
		if err := writeBase64Part(mw, textproto.MIMEHeader{
			"Content-Type":        {"application/ics; name=\"invite.ics\""},
			"Content-Disposition": {"attachment; filename=\"invite.ics\""},
		}, m.Calendar); err != nil {
			return nil, err
		}
		if err := mw.Close(); err != nil {
			return nil, err
		}
		body, ctype = mixed.Bytes(), `multipart/mixed; boundary="`+mw.Boundary()+`"`
	}

	var b bytes.Buffer
	h := func(k, v string) { b.WriteString(k + ": " + v + "\r\n") }
	h("From", from.String())
	h("To", to.String())
	if m.ReplyTo != "" {
		rt, err := mail.ParseAddress(m.ReplyTo)
		if err != nil {
			return nil, fmt.Errorf("bad reply-to: %w", err)
		}
		h("Reply-To", rt.String())
	}
	h("Subject", mime.QEncoding.Encode("utf-8", m.Subject))
	h("Date", now.Format(time.RFC1123Z))
	h("Message-ID", "<"+hex.EncodeToString(id[:])+"@"+domain+">")
	h("MIME-Version", "1.0")
	h("Auto-Submitted", "auto-generated")
	h("Content-Type", ctype)
	b.WriteString("\r\n")
	b.Write(body)
	return b.Bytes(), nil
}

func writeBase64Part(mw *multipart.Writer, hdr textproto.MIMEHeader, content string) error {
	hdr.Set("Content-Transfer-Encoding", "base64")
	w, err := mw.CreatePart(hdr)
	if err != nil {
		return err
	}
	_, err = w.Write(wrap76(base64.StdEncoding.EncodeToString([]byte(content))))
	return err
}

func wrap76(s string) []byte {
	var b bytes.Buffer
	for len(s) > 76 {
		b.WriteString(s[:76] + "\r\n")
		s = s[76:]
	}
	b.WriteString(s + "\r\n")
	return b.Bytes()
}
