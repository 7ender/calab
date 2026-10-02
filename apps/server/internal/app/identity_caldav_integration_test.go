//go:build integration

package app_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/caldav/caldavtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// Meeting content leaves Calab without a request through the CalDAV push and meeting mails:
// both follow the workspace identity policy (ADR-0054). An enforced workspace pushes only
// while the member holds a current SSO assurance; a local password session is not enough.
// An identity-suspended member of an open workspace gets nothing pushed either.
func TestIdentityCalDavPushAndMailFollowPolicy(t *testing.T) {
	f := identitySetup(t, "enforced")
	o := owner(t)
	ctx := context.Background()
	wsA, wsB, uid := uuid.MustParse(f.a.Id), uuid.MustParse(f.b.Id), uuid.MustParse(f.local.id)
	base := nextMonday()
	at := func(h int) time.Time { return base.Add(time.Duration(h) * time.Hour) }
	fake := caldavtest.New("anna", "app-pass")
	defer fake.Close()
	calDAVCAs.AddCert(fake.Certificate())
	obj := func(id string) (string, bool) { return fake.Object(fake.Calendar() + id + ".ics") }
	queued := func(id string) int {
		var n int
		if err := testDB.Pool.QueryRow(ctx, "SELECT count(*) FROM caldav_pushes WHERE user_id = $1 AND event_id = $2", uid, uuid.MustParse(id)).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	puts := func(id string) int {
		n := 0
		for _, r := range fake.Requests() {
			if r.Method == "PUT" && strings.Contains(r.Path, id) {
				n++
			}
		}
		return n
	}
	requeue := func(id string) {
		t.Helper()
		if _, err := testDB.Pool.Exec(ctx, "INSERT INTO caldav_pushes (user_id, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", uid, uuid.MustParse(id)); err != nil {
			t.Fatal(err)
		}
		waitUntil(t, "push row processed", func() bool { return queued(id) == 0 })
	}

	// Mail of an enforced workspace: no title, description, organizer, attendees or invite.ics.
	partner := "partner-" + uuid.NewString()[:8] + "@example.test"
	secret := createEvent(t, f.scoped, f.a.Id, &v1.CreateCalendarEventRequest{Title: "Secret merger", Description: "Buy the rival",
		StartsAt: ts(at(8)), EndsAt: ts(at(9)), Tz: "UTC", Attendees: []*v1.CalendarEventAttendeeInput{ext(partner)}})
	m := waitMail(t, partner, mail.TemplateEventInvite, 1)
	all := m.Subject + m.Text + m.HTML + m.Calendar + strings.Join(func() []string {
		var v []string
		for _, s := range m.Params {
			v = append(v, s)
		}
		return v
	}(), " ")
	if strings.Contains(all, "Secret merger") || strings.Contains(all, "Buy the rival") || m.Calendar != "" || m.ReplyTo != "" ||
		m.Params["rsvp_accept"] != "" || m.Params["attendees"] != "" || m.Params["url"] != "https://app.example.com/e/"+secret.GetId() {
		t.Fatalf("enforced meeting mail carries content: %q %v", m.Subject, m.Params)
	}

	// The scoped session's proof is gone: the member keeps only a local password session.
	if _, err := testDB.Q.RevokeWorkspaceAssurances(ctx, sqlc.RevokeWorkspaceAssurancesParams{WorkspaceID: wsA, UserID: &uid}); err != nil {
		t.Fatal(err)
	}
	open := createEvent(t, o, f.b.Id, &v1.CreateCalendarEventRequest{Title: "Open B", StartsAt: ts(at(10)), EndsAt: ts(at(11)), Tz: "UTC",
		Attendees: []*v1.CalendarEventAttendeeInput{att(f.local.id, true)}})

	// Backfill when the push is turned on: B's meeting, not A's.
	var resp v1.CalDavAccountResponse
	f.local.must(200, "POST", "/api/me/caldav", &v1.ConnectCalDavRequest{Url: fake.URL + "/", Username: "anna", Password: "app-pass"}, &resp)
	f.local.must(200, "PUT", "/api/me/caldav", &v1.UpdateCalDavRequest{CalendarHref: fake.URL + fake.Calendar(), Push: true}, &resp)
	waitUntil(t, "backfill of the open workspace", func() bool { _, ok := obj(open.GetId()); return ok })
	if _, ok := obj(secret.GetId()); ok || queued(secret.GetId()) != 0 {
		t.Fatal("enforced meeting queued by backfill without an SSO assurance")
	}
	// Delivery re-checks: a row queued earlier is dropped unsent.
	requeue(secret.GetId())
	if _, ok := obj(secret.GetId()); ok || puts(secret.GetId()) != 0 {
		t.Fatal("enforced meeting delivered without an SSO assurance")
	}

	// With a current SSO assurance on the local session the meeting is pushed.
	f.prove(t, uuid.MustParse(f.local.session), time.Now())
	title := "Merger v2"
	f.local.must(200, "PATCH", "/api/events/"+secret.GetId(), &v1.UpdateCalendarEventRequest{Title: &title}, nil)
	waitUntil(t, "push with assurance", func() bool { d, _ := obj(secret.GetId()); return strings.Contains(d, "SUMMARY:Merger v2") })

	// An identity-suspended member of the open workspace: neither enqueued nor delivered.
	if _, err := testDB.Q.UpsertIdentityAccess(ctx, sqlc.UpsertIdentityAccessParams{WorkspaceID: wsB, UserID: uid, Status: "suspended", Reason: "directory"}); err != nil {
		t.Fatal(err)
	}
	before := puts(open.GetId())
	renamed := "Open B renamed"
	o.must(200, "PATCH", "/api/events/"+open.GetId(), &v1.UpdateCalendarEventRequest{Title: &renamed}, nil)
	if queued(open.GetId()) != 0 {
		t.Fatal("change queued for a suspended member")
	}
	requeue(open.GetId())
	if d, _ := obj(open.GetId()); strings.Contains(d, renamed) || puts(open.GetId()) != before {
		t.Fatal("meeting delivered to a suspended member")
	}
}
