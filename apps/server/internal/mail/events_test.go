package mail

import (
	"encoding/base64"
	"io"
	"mime"
	"mime/multipart"
	netmail "net/mail"
	"strings"
	"testing"
	"time"
)

// Meeting invitations (ADR-0038 §4): multipart/mixed with the alternative (text, html, inline
// text/calendar with the method) and invite.ics attached; Reply-To; long signed links intact.
func TestEventInviteMIME(t *testing.T) {
	ics := "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n"
	long := "https://app.example.com/e/0189/rsvp?t=" + strings.Repeat("A", 150)
	p := params()
	p[ParamICS], p[ParamICSMethod], p[ParamReplyTo] = ics, "REQUEST", "Ann <ann@example.com>"
	p["rsvp_accept"], p["guest_url"], p["room"] = long, "javascript:alert(1)", "Переговорка"
	m, err := Render(TemplateEventInvite, "ru", p)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(m.Text, "Приму: "+long) || strings.Contains(m.HTML, "javascript:") || !strings.Contains(m.Text, "Комната: Переговорка") {
		t.Fatalf("actions / details: %s", m.Text)
	}
	if m.ReplyTo != "ann@example.com" || m.Calendar != ics || m.CalendarMethod != "REQUEST" || strings.Contains(m.Text, "BEGIN:VCALENDAR") {
		t.Fatalf("message: %+v", m)
	}
	if m.Subject != "Встреча: Standup — 2026-10-05" {
		t.Fatalf("subject %q", m.Subject)
	}
	m.To = "bob@example.com"
	raw, err := buildMIME(&netmail.Address{Address: "noreply@calab.example"}, m, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	msg, err := netmail.ReadMessage(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	if msg.Header.Get("Reply-To") != "<ann@example.com>" {
		t.Fatalf("reply-to %q", msg.Header.Get("Reply-To"))
	}
	mt, mp, _ := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if mt != "multipart/mixed" {
		t.Fatalf("content type %s", mt)
	}
	r := multipart.NewReader(msg.Body, mp["boundary"])
	alt, err := r.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	_, ap, _ := mime.ParseMediaType(alt.Header.Get("Content-Type"))
	ar := multipart.NewReader(alt, ap["boundary"])
	var types []string
	for {
		part, err := ar.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		types = append(types, part.Header.Get("Content-Type"))
	}
	if len(types) != 3 || types[2] != "text/calendar; charset=utf-8; method=REQUEST" {
		t.Fatalf("alternative parts %q", types)
	}
	att, err := r.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(base64.NewDecoder(base64.StdEncoding, att))
	if att.FileName() != "invite.ics" || string(body) != ics {
		t.Fatalf("attachment %q %q", att.FileName(), body)
	}
	// The cancellation has no answer buttons.
	c, err := Render(TemplateEventCancel, "en", p)
	if err != nil || strings.Contains(c.Text, long) || !strings.HasPrefix(c.Subject, "Meeting cancelled: ") {
		t.Fatalf("cancel: %v %q", err, c.Text)
	}
}
