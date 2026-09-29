//go:build integration

package app_test

import (
	"bytes"
	"context"
	"crypto/x509"
	"net/url"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/caldav"
	"github.com/calaba/calaba/server/internal/caldav/caldavtest"
)

// Free / busy, finding a time and CalDAV (ADR-0041): run with -run 'FreeBusy|Suggest|CalDav'.

var (
	calDAVCAs     = x509.NewCertPool()
	calDAVOptions = caldav.Options{
		RootCAs: calDAVCAs, PushPoll: 100 * time.Millisecond, ImportPoll: time.Hour,
		PushBackoff: func(int32) time.Duration { return 100 * time.Millisecond },
	}
)

// nextMonday: midnight UTC of the first Monday at least three days ahead.
func nextMonday() time.Time {
	d := time.Now().UTC().Truncate(24*time.Hour).AddDate(0, 0, 3)
	for d.Weekday() != time.Monday {
		d = d.AddDate(0, 0, 1)
	}
	return d
}

func setTZ(t *testing.T, u *user, tz string) {
	t.Helper()
	u.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Timezone: &tz}, nil)
}

func freeBusy(t *testing.T, u *user, wsID string, from, to time.Time, users ...string) *v1.FreeBusyResponse {
	t.Helper()
	var resp v1.FreeBusyResponse
	u.must(200, "GET", freeBusyPath(wsID, from, to, users...), nil, &resp)
	return &resp
}

func freeBusyPath(wsID string, from, to time.Time, users ...string) string {
	return "/api/workspaces/" + wsID + "/freebusy?users=" + strings.Join(users, ",") +
		"&from=" + url.QueryEscape(from.Format(time.RFC3339)) + "&to=" + url.QueryEscape(to.Format(time.RFC3339))
}

func apiCode(t *testing.T, raw []byte) v1.ErrorCode {
	t.Helper()
	var e v1.ApiError
	if err := protojson.Unmarshal(raw, &e); err != nil {
		t.Fatalf("error body %s: %v", raw, err)
	}
	return e.GetCode()
}

func TestFreeBusyAndWorkHours(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	base := nextMonday()

	// Working hours: defaults, a change, validation, guests.
	var me v1.GetMeResponse
	c.carol.must(200, "GET", "/api/me", nil, &me)
	if wh := me.GetMe().GetSettings().GetWorkHours(); wh.GetStartMin() != 600 || wh.GetEndMin() != 1140 || len(wh.GetDays()) != 5 {
		t.Fatalf("default work hours %v", wh)
	}
	var upd v1.UpdateMeResponse
	c.bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{WorkHours: &v1.WorkHours{StartMin: 540, EndMin: 1080, Days: []uint32{5, 1, 2, 3, 4}}}, &upd)
	if wh := upd.GetMe().GetSettings().GetWorkHours(); wh.GetStartMin() != 540 || wh.GetDays()[0] != 1 {
		t.Fatalf("work hours %v", wh)
	}
	c.bob.must(422, "PATCH", "/api/me", &v1.UpdateMeRequest{WorkHours: &v1.WorkHours{StartMin: 600, EndMin: 500, Days: []uint32{1}}}, nil)
	anon, _ := anonGuest(t, roomLink(t, c.o, c.voice.GetId(), &v1.CreateRoomInviteRequest{}).GetCode(), "Guest")
	anon.must(403, "PATCH", "/api/me", &v1.UpdateMeRequest{WorkHours: &v1.WorkHours{StartMin: 0, EndMin: 60, Days: []uint32{1}}}, nil)
	// A settings replace leaves them as they are.
	c.bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Settings: &v1.UserSettings{MicMode: v1.MicMode_MIC_MODE_VAD}}, &upd)
	if upd.GetMe().GetSettings().GetWorkHours().GetStartMin() != 540 {
		t.Fatal("settings replace changed work hours")
	}
	setTZ(t, c.carol, "America/New_York")

	start := base.Add(10 * time.Hour)
	e1 := createEvent(t, c.bob, wsID, &v1.CreateCalendarEventRequest{Title: "E1", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)),
		Tz: "UTC", RoomId: c.voice.GetId(), Attendees: []*v1.CalendarEventAttendeeInput{att(c.carol.id, true)}})
	createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "private", StartsAt: ts(start.Add(2 * time.Hour)),
		EndsAt: ts(start.Add(3 * time.Hour)), Tz: "UTC", Attendees: []*v1.CalendarEventAttendeeInput{att(c.carol.id, true)}})
	e3 := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "declined", StartsAt: ts(start.Add(4 * time.Hour)),
		EndsAt: ts(start.Add(5 * time.Hour)), Tz: "UTC", Attendees: []*v1.CalendarEventAttendeeInput{att(c.carol.id, true)}})
	c.carol.must(200, "PUT", "/api/events/"+e3.GetId()+"/rsvp", &v1.RsvpCalendarEventRequest{Status: v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED}, nil)
	createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "offsite", StartsAt: ts(base.Add(24 * time.Hour)),
		EndsAt: ts(base.Add(48 * time.Hour)), AllDay: true, Tz: "Europe/Moscow", Attendees: []*v1.CalendarEventAttendeeInput{att(c.carol.id, true)}})

	resp := freeBusy(t, c.bob, wsID, base, base.Add(3*24*time.Hour), c.carol.id, c.bob.id)
	if len(resp.GetUsers()) != 2 || resp.GetUsers()[0].GetUserId() != c.carol.id {
		t.Fatalf("users %v", resp.GetUsers())
	}
	carol, bob := resp.GetUsers()[0], resp.GetUsers()[1]
	if carol.GetTimezone() != "America/New_York" || bob.GetTimezone() != "UTC" || bob.GetWorkHours().GetStartMin() != 540 {
		t.Fatalf("zones / hours %v %v", carol, bob)
	}
	busy := carol.GetBusy()
	if len(busy) != 3 {
		t.Fatalf("carol busy %v", busy)
	}
	if busy[0].GetEventId() != e1.GetId() || busy[0].GetKind() != v1.BusyKind_BUSY_KIND_MEETING || !busy[0].GetStartsAt().AsTime().Equal(start) {
		t.Errorf("visible meeting %v", busy[0])
	}
	if busy[1].GetEventId() != "" || !busy[1].GetStartsAt().AsTime().Equal(start.Add(2*time.Hour)) {
		t.Errorf("hidden meeting %v", busy[1])
	}
	ny, _ := time.LoadLocation("America/New_York")
	tue := base.Add(24 * time.Hour)
	if !busy[2].GetAllDay() || !busy[2].GetStartsAt().AsTime().Equal(time.Date(tue.Year(), tue.Month(), tue.Day(), 0, 0, 0, 0, ny)) ||
		busy[2].GetEventId() != "" {
		t.Errorf("all-day in the person's zone %v", busy[2])
	}
	if len(bob.GetBusy()) != 1 || bob.GetBusy()[0].GetEventId() != e1.GetId() {
		t.Errorf("bob busy %v", bob.GetBusy())
	}
	// carol sees the ids of her own meetings.
	if b := freeBusy(t, c.carol, wsID, base, base.Add(3*24*time.Hour), c.carol.id).GetUsers()[0].GetBusy(); len(b) != 3 || b[1].GetEventId() == "" {
		t.Errorf("own busy %v", b)
	}

	// Limits and access.
	c.gus.must(403, "GET", freeBusyPath(wsID, base, base.Add(time.Hour), c.bob.id), nil, nil)
	c.bob.must(422, "GET", freeBusyPath(wsID, base, base.Add(15*24*time.Hour), c.bob.id), nil, nil)
	c.bob.must(422, "GET", freeBusyPath(wsID, base, base.Add(time.Hour), c.gus.id), nil, nil)
	_, stranger, _, _ := setupTeam(t)
	c.bob.must(422, "GET", freeBusyPath(wsID, base, base.Add(time.Hour), stranger.id), nil, nil)
	stranger.must(404, "GET", freeBusyPath(wsID, base, base.Add(time.Hour), c.bob.id), nil, nil)
	many := make([]string, 21)
	for i := range many {
		many[i] = c.bob.id
	}
	many[20] = c.carol.id
	c.bob.must(200, "GET", freeBusyPath(wsID, base, base.Add(time.Hour), many...), nil, nil) // duplicates collapse
}

func TestSuggestSlots(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	base := nextMonday()
	// bob: Moscow 09–18 (06–15Z); carol: Tokyo 10–19 (01–10Z) → common 06–10Z.
	setTZ(t, c.bob, "Europe/Moscow")
	setTZ(t, c.carol, "Asia/Tokyo")
	c.bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{WorkHours: &v1.WorkHours{StartMin: 540, EndMin: 1080, Days: []uint32{1, 2, 3, 4, 5}}}, nil)
	suggest := func(req *v1.SuggestSlotsRequest) []time.Time {
		t.Helper()
		var resp v1.SuggestSlotsResponse
		c.bob.must(200, "POST", "/api/workspaces/"+wsID+"/freebusy/suggest", req, &resp)
		var out []time.Time
		for _, s := range resp.GetSlots() {
			if s.GetEndsAt().AsTime().Sub(s.GetStartsAt().AsTime()) != time.Duration(req.GetDurationMin())*time.Minute {
				t.Fatalf("slot length %v", s)
			}
			out = append(out, s.GetStartsAt().AsTime())
		}
		return out
	}
	req := func() *v1.SuggestSlotsRequest {
		return &v1.SuggestSlotsRequest{Users: []string{c.bob.id, c.carol.id}, DurationMin: 60, From: ts(base), To: ts(base.Add(24 * time.Hour)), WithinWorkHours: true}
	}
	h := func(hh, mm int) time.Time {
		return base.Add(time.Duration(hh)*time.Hour + time.Duration(mm)*time.Minute)
	}
	got := suggest(req())
	if len(got) != 10 || !got[0].Equal(h(6, 0)) || !got[9].Equal(h(8, 15)) {
		t.Fatalf("free day %v", got)
	}
	createEvent(t, c.bob, wsID, &v1.CreateCalendarEventRequest{Title: "busy", StartsAt: ts(h(6, 0)), EndsAt: ts(h(8, 0)), Tz: "UTC",
		Attendees: []*v1.CalendarEventAttendeeInput{att(c.carol.id, true)}})
	if got = suggest(req()); len(got) != 5 || !got[0].Equal(h(8, 0)) || !got[4].Equal(h(9, 0)) {
		t.Fatalf("after a meeting %v", got)
	}
	// The room is taken 09:00–09:30 by a meeting of other people.
	createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "room", StartsAt: ts(h(9, 0)), EndsAt: ts(h(9, 30)), Tz: "UTC", RoomId: c.voice.GetId()})
	r := req()
	r.RoomId = c.voice.GetId()
	if got = suggest(r); len(got) != 1 || !got[0].Equal(h(8, 0)) {
		t.Fatalf("with the room %v", got)
	}
	// Anywhere in the day: from midnight.
	r = req()
	r.WithinWorkHours = false
	if got = suggest(r); len(got) != 10 || !got[0].Equal(h(0, 0)) {
		t.Fatalf("any time %v", got)
	}
	// No common hours.
	c.carol.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{WorkHours: &v1.WorkHours{StartMin: 600, EndMin: 1140, Days: []uint32{6, 7}}}, nil)
	if st := c.bob.do("POST", "/api/workspaces/"+wsID+"/freebusy/suggest", req(), nil); st != 409 ||
		apiCode(t, c.bob.lastBody) != v1.ErrorCode_ERROR_CODE_NO_COMMON_HOURS {
		t.Fatalf("no common hours: %d %s", st, c.bob.lastBody)
	}
	// Validation and access.
	r = req()
	r.DurationMin = 0
	c.bob.must(422, "POST", "/api/workspaces/"+wsID+"/freebusy/suggest", r, nil)
	r = req()
	r.Users = nil
	c.bob.must(422, "POST", "/api/workspaces/"+wsID+"/freebusy/suggest", r, nil)
	r = req()
	r.RoomId = c.text + "x"
	c.bob.must(422, "POST", "/api/workspaces/"+wsID+"/freebusy/suggest", r, nil)
	c.gus.must(403, "POST", "/api/workspaces/"+wsID+"/freebusy/suggest", req(), nil)
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out: %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestCalDavConnectImportPush(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	base := nextMonday()
	fake := caldavtest.New("anna", "app-pass")
	defer fake.Close()
	calDAVCAs.AddCert(fake.Certificate())

	var resp v1.CalDavAccountResponse
	c.bob.must(200, "GET", "/api/me/caldav", nil, &resp)
	if resp.GetAccount() != nil {
		t.Fatal("account before connecting")
	}
	anon, _ := anonGuest(t, roomLink(t, c.o, c.voice.GetId(), &v1.CreateRoomInviteRequest{}).GetCode(), "Guest")
	anon.must(403, "GET", "/api/me/caldav", nil, nil)
	if st := c.bob.do("POST", "/api/me/caldav", &v1.ConnectCalDavRequest{Url: fake.URL + "/", Username: "anna", Password: "nope"}, nil); st != 422 ||
		!bytes.Contains(c.bob.lastBody, []byte(`"password"`)) {
		t.Fatalf("bad password: %d %s", st, c.bob.lastBody)
	}
	if st := c.bob.do("POST", "/api/me/caldav", &v1.ConnectCalDavRequest{Url: strings.Replace(fake.URL, "https", "http", 1), Username: "anna", Password: "app-pass"}, nil); st != 422 ||
		!bytes.Contains(c.bob.lastBody, []byte(`"url"`)) {
		t.Fatalf("http: %d %s", st, c.bob.lastBody)
	}
	c.bob.must(200, "POST", "/api/me/caldav", &v1.ConnectCalDavRequest{Url: fake.URL + "/", Username: "anna", Password: "app-pass"}, &resp)
	acc := resp.GetAccount()
	work := fake.URL + fake.Calendar()
	if len(acc.GetCalendars()) != 2 || acc.GetCalendars()[0].GetHref() != work || acc.GetCalendarHref() != "" || !acc.GetImport() || acc.GetPush() {
		t.Fatalf("account %v", acc)
	}
	var sealed []byte
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT secret_enc FROM caldav_accounts WHERE user_id = $1", c.bob.id).Scan(&sealed); err != nil ||
		bytes.Contains(sealed, []byte("app-pass")) {
		t.Fatalf("password stored in clear (%v)", err)
	}
	c.bob.must(422, "POST", "/api/me/caldav/sync", nil, nil) // no calendar yet
	c.bob.must(422, "PUT", "/api/me/caldav", &v1.UpdateCalDavRequest{CalendarHref: fake.URL + "/elsewhere/", Import: true}, nil)

	// A meeting from before the push is turned on is pushed too.
	early := createEvent(t, c.bob, wsID, &v1.CreateCalendarEventRequest{Title: "Early", StartsAt: ts(base.Add(8 * time.Hour)),
		EndsAt: ts(base.Add(9 * time.Hour)), Tz: "UTC"})
	c.bob.must(200, "PUT", "/api/me/caldav", &v1.UpdateCalDavRequest{CalendarHref: work, Import: true, Push: true}, &resp)
	if resp.GetAccount().GetCalendarHref() != work || !resp.GetAccount().GetPush() {
		t.Fatalf("update %v", resp.GetAccount())
	}
	obj := func(id string) (string, bool) { return fake.Object(fake.Calendar() + id + ".ics") }
	waitUntil(t, "backfilled push", func() bool { _, ok := obj(early.GetId()); return ok })

	// Import: a two-day series, a free event and a cancelled one.
	d := base.Format("20060102")
	fake.SetObject("ext.ics", "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ext-1\r\nSUMMARY:Dentist\r\nDTSTART:"+d+"T160000Z\r\n"+
		"DTEND:"+d+"T170000Z\r\nRRULE:FREQ=DAILY;COUNT=2\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:ext-2\r\nDTSTART:"+d+"T180000Z\r\n"+
		"DTEND:"+d+"T190000Z\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
	c.bob.must(200, "POST", "/api/me/caldav/sync", nil, &resp)
	if resp.GetAccount().GetLastSyncAt() == nil || resp.GetAccount().GetLastError() != "" {
		t.Fatalf("sync %v", resp.GetAccount())
	}
	c.bob.must(429, "POST", "/api/me/caldav/sync", nil, nil) // once a minute
	fb := freeBusy(t, c.carol, wsID, base, base.Add(3*24*time.Hour), c.bob.id).GetUsers()[0].GetBusy()
	var ext []*v1.BusyInterval
	for _, b := range fb {
		if b.GetKind() == v1.BusyKind_BUSY_KIND_EXTERNAL {
			ext = append(ext, b)
		}
	}
	if len(ext) != 2 || ext[0].GetEventId() != "" || !ext[0].GetStartsAt().AsTime().Equal(base.Add(16*time.Hour)) ||
		!ext[1].GetStartsAt().AsTime().Equal(base.Add(40*time.Hour)) {
		t.Fatalf("external busy %v", fb)
	}
	var titles int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM external_busy WHERE user_id = $1 AND uid = 'ext-1'", c.bob.id).Scan(&titles); err != nil || titles != 0 {
		t.Fatalf("raw uid stored (%v)", err)
	}

	// Push: create → PUT, the .ics has no scheduling lines; cancel → DELETE.
	ev := createEvent(t, c.bob, wsID, &v1.CreateCalendarEventRequest{Title: "Sync me", StartsAt: ts(base.Add(10 * time.Hour)),
		EndsAt: ts(base.Add(11 * time.Hour)), Tz: "UTC", Attendees: []*v1.CalendarEventAttendeeInput{att(c.carol.id, true)}})
	waitUntil(t, "push on create", func() bool { _, ok := obj(ev.GetId()); return ok })
	data, _ := obj(ev.GetId())
	if !strings.Contains(data, "UID:"+ev.GetId()+"@calab") || !strings.Contains(data, "SUMMARY:Sync me") ||
		strings.Contains(data, "ORGANIZER") || strings.Contains(data, "ATTENDEE") || strings.Contains(data, "METHOD") {
		t.Fatalf("pushed object:\n%s", data)
	}
	title := "Synced"
	c.bob.must(200, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{Title: &title}, nil)
	waitUntil(t, "push on update", func() bool { d, _ := obj(ev.GetId()); return strings.Contains(d, "SUMMARY:Synced") })
	c.bob.must(204, "DELETE", "/api/events/"+ev.GetId(), nil, nil)
	waitUntil(t, "delete on cancel", func() bool { _, ok := obj(ev.GetId()); return !ok })

	// Declining someone else's meeting removes it from the calendar.
	other := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Invite", StartsAt: ts(base.Add(12 * time.Hour)),
		EndsAt: ts(base.Add(13 * time.Hour)), Tz: "UTC", Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true)}})
	waitUntil(t, "push of an invitation", func() bool { _, ok := obj(other.GetId()); return ok })
	c.bob.must(200, "PUT", "/api/events/"+other.GetId()+"/rsvp", &v1.RsvpCalendarEventRequest{Status: v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED}, nil)
	waitUntil(t, "delete on decline", func() bool { _, ok := obj(other.GetId()); return !ok })

	// A failing server: retried, then the error is shown.
	fake.FailPut = 500
	failing := createEvent(t, c.bob, wsID, &v1.CreateCalendarEventRequest{Title: "Fail", StartsAt: ts(base.Add(14 * time.Hour)),
		EndsAt: ts(base.Add(15 * time.Hour)), Tz: "UTC"})
	waitUntil(t, "push gives up", func() bool {
		c.bob.must(200, "GET", "/api/me/caldav", nil, &resp)
		return strings.Contains(resp.GetAccount().GetLastError(), "HTTP 500")
	})
	puts := 0
	for _, r := range fake.Requests() {
		if r.Method == "PUT" && strings.Contains(r.Path, failing.GetId()) {
			puts++
		}
	}
	if puts != caldav.PushAttempts {
		t.Errorf("%d attempts, want %d", puts, caldav.PushAttempts)
	}
	fake.FailPut = 0

	// Disconnecting removes the imported busy time.
	c.bob.must(204, "DELETE", "/api/me/caldav", nil, nil)
	c.bob.must(200, "GET", "/api/me/caldav", nil, &resp)
	if resp.GetAccount() != nil {
		t.Fatal("account after delete")
	}
	for _, b := range freeBusy(t, c.carol, wsID, base, base.Add(3*24*time.Hour), c.bob.id).GetUsers()[0].GetBusy() {
		if b.GetKind() == v1.BusyKind_BUSY_KIND_EXTERNAL {
			t.Fatalf("external busy after delete %v", b)
		}
	}
}
