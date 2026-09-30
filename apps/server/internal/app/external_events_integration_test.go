//go:build integration

package app_test

import (
	"bytes"
	"net/url"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/caldav/caldavtest"
)

// Details of imported events (ADR-0045): the owner sees everything, colleagues by share_level.
func TestExternalEventDetails(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	base := nextMonday()
	fake := caldavtest.New("anna", "app-pass")
	defer fake.Close()
	calDAVCAs.AddCert(fake.Certificate())

	var resp v1.CalDavAccountResponse
	c.bob.must(200, "POST", "/api/me/caldav", &v1.ConnectCalDavRequest{Url: fake.URL + "/", Username: "anna", Password: "app-pass"}, &resp)
	if resp.GetAccount().GetShareLevel() != v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_BUSY {
		t.Fatalf("default share level %v", resp.GetAccount().GetShareLevel())
	}
	c.bob.must(200, "PUT", "/api/me/caldav", &v1.UpdateCalDavRequest{CalendarHref: fake.URL + fake.Calendar(), Import: true}, nil)
	d := base.Format("20060102")
	fake.SetObject("board.ics", "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:board-1\r\nSUMMARY:Board sync\\, Q4\r\n"+
		"LOCATION:Room 7\r\nURL:https://meet.example/board\r\nORGANIZER;CN=Boss:mailto:boss@partner.org\r\n"+
		"ATTENDEE;CN=Carol:mailto:"+strings.ToUpper(c.carol.email)+"\r\nATTENDEE;CN=Gus:mailto:"+c.gus.email+"\r\n"+
		"ATTENDEE;CN=Out:mailto:outsider@partner.org\r\nDESCRIPTION:password 42\r\nDTSTART:"+d+"T090000Z\r\nDTEND:"+d+"T100000Z\r\n"+
		"END:VEVENT\r\nEND:VCALENDAR\r\n")
	c.bob.must(200, "POST", "/api/me/caldav/sync", nil, &resp)
	if resp.GetAccount().GetLastError() != "" {
		t.Fatalf("sync %v", resp.GetAccount())
	}
	from, to := base, base.Add(24*time.Hour)
	window := "from=" + url.QueryEscape(from.Format(time.RFC3339)) + "&to=" + url.QueryEscape(to.Format(time.RFC3339))

	// Mine: every detail; with the workspace, members (not guests) get their id.
	var mine v1.ExternalEventsResponse
	c.bob.must(200, "GET", "/api/me/external-events?"+window+"&workspace="+wsID, nil, &mine)
	if len(mine.GetEvents()) != 1 {
		t.Fatalf("my events %v", mine.GetEvents())
	}
	ev := mine.GetEvents()[0]
	if ev.GetSummary() != "Board sync, Q4" || ev.GetLocation() != "Room 7" || ev.GetUrl() != "https://meet.example/board" ||
		ev.GetOrganizer() != "boss@partner.org" || !ev.GetStartsAt().AsTime().Equal(base.Add(9*time.Hour)) || len(ev.GetAttendees()) != 3 {
		t.Fatalf("my event %v", ev)
	}
	ids := map[string]string{}
	for _, a := range ev.GetAttendees() {
		ids[a.GetEmail()] = a.GetUserId()
	}
	if ids[strings.ToLower(c.carol.email)] != c.carol.id || ids[c.gus.email] != "" || ids["outsider@partner.org"] != "" {
		t.Fatalf("attendee ids %v", ids)
	}
	c.bob.must(200, "GET", "/api/me/external-events?"+window, nil, &mine) // no workspace: no ids
	for _, a := range mine.GetEvents()[0].GetAttendees() {
		if a.GetUserId() != "" {
			t.Fatalf("id without a workspace %v", a)
		}
	}
	if bytes.Contains(c.bob.lastBody, []byte("password 42")) {
		t.Fatal("the description leaked")
	}
	c.bob.must(422, "GET", "/api/me/external-events?from="+url.QueryEscape(from.Format(time.RFC3339))+"&to="+url.QueryEscape(from.Add(15*24*time.Hour).Format(time.RFC3339)), nil, nil)
	c.gus.must(403, "GET", "/api/me/external-events?"+window+"&workspace="+wsID, nil, nil) // a guest of the workspace
	anon, _ := anonGuest(t, roomLink(t, c.o, c.voice.GetId(), &v1.CreateRoomInviteRequest{}).GetCode(), "Guest")
	anon.must(403, "GET", "/api/me/external-events?"+window, nil, nil)
	b := createBot(t, c.o, wsID, "Cal")
	b.must(403, "GET", "/api/me/external-events?"+window, nil, nil)
	b.must(403, "PATCH", "/api/me/caldav", &v1.SetCalDavShareRequest{ShareLevel: v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_DETAILS}, nil)

	// A colleague: by the level. Place, organizer, link and outside addresses never.
	colleague := func() *v1.BusyInterval {
		t.Helper()
		var fb v1.FreeBusyResponse
		c.carol.must(200, "GET", freeBusyPath(wsID, from, to, c.bob.id), nil, &fb)
		for _, x := range []string{"Room 7", "meet.example", "boss@", "outsider@", "password"} {
			if bytes.Contains(c.carol.lastBody, []byte(x)) {
				t.Fatalf("%q leaked to a colleague: %s", x, c.carol.lastBody)
			}
		}
		for _, bi := range fb.GetUsers()[0].GetBusy() {
			if bi.GetKind() == v1.BusyKind_BUSY_KIND_EXTERNAL {
				return bi
			}
		}
		t.Fatal("no external interval")
		return nil
	}
	if bi := colleague(); bi.GetTitle() != "" || len(bi.GetAttendeeUserIds()) != 0 {
		t.Fatalf("busy level shows %v", bi)
	}
	c.bob.must(422, "PATCH", "/api/me/caldav", &v1.SetCalDavShareRequest{}, nil)
	c.carol.must(404, "PATCH", "/api/me/caldav", &v1.SetCalDavShareRequest{ShareLevel: v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_TITLE}, nil)
	c.bob.must(200, "PATCH", "/api/me/caldav", &v1.SetCalDavShareRequest{ShareLevel: v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_TITLE}, &resp)
	if resp.GetAccount().GetShareLevel() != v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_TITLE {
		t.Fatalf("level %v", resp.GetAccount())
	}
	if bi := colleague(); bi.GetTitle() != "Board sync, Q4" || len(bi.GetAttendeeUserIds()) != 0 {
		t.Fatalf("title level shows %v", bi)
	}
	c.bob.must(200, "PATCH", "/api/me/caldav", &v1.SetCalDavShareRequest{ShareLevel: v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_DETAILS}, nil)
	if bi := colleague(); bi.GetTitle() != "Board sync, Q4" || len(bi.GetAttendeeUserIds()) != 1 || bi.GetAttendeeUserIds()[0] != c.carol.id {
		t.Fatalf("details level shows %v", bi)
	}
	// Guests of the workspace see nothing.
	c.gus.must(403, "GET", freeBusyPath(wsID, from, to, c.bob.id), nil, nil)

	// Reconnecting keeps the level; disconnecting removes the details.
	c.bob.must(200, "POST", "/api/me/caldav", &v1.ConnectCalDavRequest{Url: fake.URL + "/", Username: "anna", Password: "app-pass"}, &resp)
	if resp.GetAccount().GetShareLevel() != v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_DETAILS {
		t.Fatalf("level after reconnect %v", resp.GetAccount().GetShareLevel())
	}
	c.bob.must(204, "DELETE", "/api/me/caldav", nil, nil)
	c.bob.must(200, "GET", "/api/me/external-events?"+window, nil, &mine)
	if len(mine.GetEvents()) != 0 {
		t.Fatalf("events after disconnect %v", mine.GetEvents())
	}
}
