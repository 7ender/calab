//go:build integration

package app_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/perm"
)

// Extended bot API (ADR-0051): every route opened to bots answers 2xx with the right bit and 403
// without it; restricted rooms and boards (ADR-0029, ADR-0048) stay invisible to bots.

// giveBot gives the bot one more role with bits (the owner assigns it; the roles it has stay).
func giveBot(t *testing.T, o *user, wsID string, b *bot, name string, bits perm.Bits) {
	t.Helper()
	role := newRole(t, o, wsID, name, bits)
	var p v1.GetMemberResponse
	o.must(200, "GET", "/api/workspaces/"+wsID+"/members/"+b.id, nil, &p)
	if st, _ := setMemberRoles(o, wsID, b.id, append(p.GetMember().GetRoleIds(), role.GetId())...); st != 200 {
		t.Fatalf("bot role %s: %d", name, st)
	}
}

// restrictedRoom creates a private room closed to administrators (ADR-0048), seen by the owner
// and by the given users.
func restrictedRoom(t *testing.T, o *user, wsID string, typ v1.RoomType, name string, users ...string) string {
	t.Helper()
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wsID+"/rooms", &v1.CreateRoomRequest{Type: typ, Name: name, IsPrivate: true}, &cr)
	id := cr.GetRoom().GetId()
	ovs := slices.Clone(cr.GetRoom().GetPermissionOverrides())
	for _, u := range users {
		ovs = append(ovs, userOv(u, perm.ViewRoom|perm.Connect, 0))
	}
	o.must(200, "PUT", "/api/rooms/"+id+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: ovs}, nil)
	on := true
	o.must(200, "PATCH", "/api/rooms/"+id, &v1.UpdateRoomRequest{Restricted: &on}, nil)
	return id
}

// restrictedBoard creates a private board closed to administrators, seen by the given users.
func restrictedBoard(t *testing.T, o *user, wsID, name string, users ...string) *v1.Board {
	t.Helper()
	b := createBoard(t, o, wsID, &v1.CreateBoardRequest{Name: name, IsPrivate: true}, 201)
	ovs := slices.Clone(b.GetPermissionOverrides())
	for _, u := range users {
		ovs = append(ovs, userOv(u, perm.ViewBoard|perm.CreateTasks, 0))
	}
	setBoardPerms(o, b.GetId(), 200, ovs...)
	on := true
	var r v1.BoardResponse
	o.must(200, "PATCH", "/api/boards/"+b.GetId(), &v1.UpdateBoardRequest{Restricted: &on}, &r)
	return r.GetBoard()
}

// TestBotAPIv2Calendar: a bot organizes meetings (never an attendee), mails go out on its
// behalf, others' meetings need MANAGE_EVENTS, free / busy without external details, RSVP
// closed, a restricted room's meetings invisible.
func TestBotAPIv2Calendar(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	b := createBot(t, c.o, wsID, "Planner")
	start := time.Now().Add(72 * time.Hour).Truncate(time.Minute)
	partner := uniq("botcal") + "@outside.org"

	// The bot may not attend its own meeting.
	b.must(422, "POST", "/api/workspaces/"+wsID+"/events", &v1.CreateCalendarEventRequest{Title: "Self", StartsAt: ts(start),
		EndsAt: ts(start.Add(time.Hour)), Tz: "UTC", Attendees: []*v1.CalendarEventAttendeeInput{att(b.id, true)}}, nil)

	// Create: the bot organizes, bob and an outside address attend; the bot sees the addresses.
	bg := dialGW(t)
	bg.identify(b.token)
	var cr v1.CalendarEventResponse
	b.must(201, "POST", "/api/workspaces/"+wsID+"/events", &v1.CreateCalendarEventRequest{Title: "Bot sync", StartsAt: ts(start),
		EndsAt: ts(start.Add(time.Hour)), Tz: "UTC", RoomId: c.voice.GetId(),
		Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true), ext(partner)}}, &cr)
	ev := cr.GetEvent()
	if ev.GetOrganizerId() != b.id || attendeeOf(ev, b.id, "") != nil || attendeeOf(ev, "", partner) == nil || !ev.GetCanEdit() || ev.GetGuestLinks() {
		t.Fatalf("bot's meeting: %v", ev)
	}
	got := bg.wait("EVENT_CREATE to the organizing bot", func(e *v1.DispatchEvent) bool {
		return e.GetEventCreate().GetEvent().GetId() == ev.GetId()
	}).GetEventCreate().GetEvent()
	if attendeeOf(got, "", partner) == nil {
		t.Fatalf("the organizing bot's EVENT_CREATE without the address: %v", got)
	}

	// Mail: the workspace on behalf of the bot, the system address, no Reply-To, no guest link.
	m := waitMail(t, partner, mail.TemplateEventInvite, 1)
	if org := m.Params["organizer"]; !strings.Contains(org, c.ws.GetName()) || !strings.Contains(org, "Planner") || org == "Planner" {
		t.Fatalf("organizer of a bot's meeting: %q", org)
	}
	if m.ReplyTo != "" || m.Params["guest_url"] != "" || !strings.Contains(unfoldICS(m.Calendar), "ORGANIZER;CN=") {
		t.Fatalf("bot meeting mail: reply-to %q guest %q\n%s", m.ReplyTo, m.Params["guest_url"], m.Calendar)
	}
	waitMail(t, c.bob.email, mail.TemplateEventInvite, 1)

	// Bob sees it (attendee) with the organizer's id; the bot changes and cancels its own.
	var bobView v1.CalendarEventResponse
	c.bob.must(200, "GET", "/api/events/"+ev.GetId(), nil, &bobView)
	if bobView.GetEvent().GetOrganizerId() != b.id || bobView.GetEvent().GetCanEdit() {
		t.Fatalf("bob's view: %v", bobView.GetEvent())
	}
	title := "Bot sync (moved)"
	var up v1.CalendarEventResponse
	b.must(200, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{Title: &title, SetAttendees: true,
		Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true), att(c.carol.id, false)}}, &up)
	if up.GetEvent().GetTitle() != title || attendeeOf(up.GetEvent(), b.id, "") != nil || attendeeOf(up.GetEvent(), c.carol.id, "") == nil {
		t.Fatalf("bot update: %v", up.GetEvent())
	}
	b.must(403, "PUT", "/api/events/"+ev.GetId()+"/rsvp", &v1.RsvpCalendarEventRequest{Status: v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED}, nil)
	if r, _ := errReason(b.client); r != "BOT_NOT_ALLOWED" {
		t.Fatalf("bot rsvp: %q", r)
	}
	b.must(204, "DELETE", "/api/events/"+ev.GetId(), nil, nil)

	// Others' meetings: 403 without MANAGE_EVENTS, 2xx with it.
	other := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Owner's", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)),
		Tz: "UTC", RoomId: c.voice.GetId(), Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true)}})
	b.must(403, "PATCH", "/api/events/"+other.GetId(), &v1.UpdateCalendarEventRequest{Title: &title}, nil)
	b.must(403, "DELETE", "/api/events/"+other.GetId(), nil, nil)
	giveBot(t, c.o, wsID, b, "Events", perm.ManageEvents)
	b.must(200, "PATCH", "/api/events/"+other.GetId(), &v1.UpdateCalendarEventRequest{Title: &title}, nil)
	b.must(204, "DELETE", "/api/events/"+other.GetId(), nil, nil)

	// A restricted room: its meetings are invisible to the bot, even with MANAGE_EVENTS; it
	// cannot book the room.
	secret := restrictedRoom(t, c.o, wsID, v1.RoomType_ROOM_TYPE_VOICE, "secret-voice", c.bob.id)
	hidden := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Hidden", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)),
		Tz: "UTC", RoomId: secret, Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true)}})
	b.must(404, "GET", "/api/events/"+hidden.GetId(), nil, nil)
	b.must(404, "PATCH", "/api/events/"+hidden.GetId(), &v1.UpdateCalendarEventRequest{Title: &title}, nil)
	for _, e := range listEvents(t, &user{client: b.client}, wsID, start.Add(-time.Hour), start.Add(2*time.Hour)) {
		if e.GetId() == hidden.GetId() {
			t.Fatal("a bot lists a meeting of a restricted room")
		}
	}
	b.must(422, "POST", "/api/workspaces/"+wsID+"/events", &v1.CreateCalendarEventRequest{Title: "X", StartsAt: ts(start),
		EndsAt: ts(start.Add(time.Hour)), Tz: "UTC", RoomId: secret}, nil)

	// Free / busy: bob is busy (the hidden meeting, without its id); suggest works.
	fb := freeBusy(t, &user{client: b.client}, wsID, start.Add(-time.Hour), start.Add(2*time.Hour), c.bob.id)
	busy := fb.GetUsers()[0].GetBusy()
	if len(busy) == 0 {
		t.Fatalf("bot freebusy: no busy time for bob: %v", fb)
	}
	for _, x := range busy {
		if x.GetEventId() == hidden.GetId() || x.GetTitle() != "" || len(x.GetAttendeeUserIds()) > 0 {
			t.Fatalf("bot freebusy details: %v", x)
		}
	}
	var sl v1.SuggestSlotsResponse
	b.must(200, "POST", "/api/workspaces/"+wsID+"/freebusy/suggest", &v1.SuggestSlotsRequest{Users: []string{c.bob.id}, DurationMin: 30,
		From: ts(start.Add(-time.Hour)), To: ts(start.Add(3 * time.Hour))}, &sl)
	if len(sl.GetSlots()) == 0 {
		t.Fatal("bot suggest: no slots")
	}
	// Guests stay out, the bot is never asked about.
	c.gus.must(403, "GET", freeBusyPath(wsID, start, start.Add(time.Hour), c.bob.id), nil, nil)
	b.must(422, "GET", freeBusyPath(wsID, start, start.Add(time.Hour), b.id), nil, nil)
}

// TestBotAPIv2Profile: GET …/members/{userId} for bots and people — the member, open tasks of
// visible boards only (a restricted board stays hidden even from an manager bot), guests
// see only visible members, a hidden birthday is not sent.
func TestBotAPIv2Profile(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wsID := ws.GetId()
	b := createBot(t, o, wsID, "Profiler")
	giveBot(t, o, wsID, b, "Manager", perm.RolesV2|perm.ManageWorkspace|perm.ManageNicknames|perm.ManageRoom)
	open := createBoard(t, o, wsID, &v1.CreateBoardRequest{Name: "Open"}, 201)
	closed := restrictedBoard(t, o, wsID, "Closed", bob.id)
	visible := createTask(t, o, open.GetId(), &v1.CreateTaskRequest{Title: "Visible", Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, 201)
	createTask(t, o, open.GetId(), &v1.CreateTaskRequest{Title: "Not bob's"}, 201)
	secret := createTask(t, o, closed.GetId(), &v1.CreateTaskRequest{Title: "Secret", Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, 201)
	bob.must(200, "PATCH", "/api/me", bday(3, 4, 1990), nil)
	bob.must(200, "PATCH", "/api/me", hideBirthday(true), nil)

	path := "/api/workspaces/" + wsID + "/members/"
	var p v1.GetMemberResponse
	b.must(200, "GET", path+bob.id, nil, &p)
	if p.GetMember().GetUser().GetId() != bob.id || p.GetMember().GetUser().GetBirthday() != nil || len(p.GetMember().GetRoleIds()) == 0 {
		t.Fatalf("bot reads bob: %v", p.GetMember())
	}
	ids := []string{}
	for _, tk := range p.GetOpenTasks() {
		ids = append(ids, tk.GetId())
	}
	if !slices.Contains(ids, visible.GetId()) || slices.Contains(ids, secret.GetId()) || len(ids) != 1 {
		t.Fatalf("bot sees bob's open tasks %v (visible %s, secret %s)", ids, visible.GetId(), secret.GetId())
	}
	// Bob sees his own, the secret one included; "@me" works for bots too.
	bob.must(200, "GET", path+"@me", nil, &p)
	if len(p.GetOpenTasks()) != 2 || p.GetMember().GetUser().GetBirthday() != nil {
		t.Fatalf("bob's own profile: %d tasks", len(p.GetOpenTasks()))
	}
	b.must(200, "GET", path+"@me", nil, &p)
	if !p.GetMember().GetUser().GetIsBot() || len(p.GetOpenTasks()) != 0 {
		t.Fatalf("bot's own profile: %v", &p)
	}
	// Not a member: 404; another workspace: 404.
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	outsider := register(t, invite(t, o, other.GetId()))
	b.must(404, "GET", path+outsider.id, nil, nil)
	outsider.must(404, "GET", path+bob.id, nil, nil)
	// A guest sees exactly the members of its list (those it shares a room with), no tasks.
	gus := register(t, invite(t, o, wsID))
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", path+gus.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	var gl v1.ListMembersResponse
	gus.must(200, "GET", "/api/workspaces/"+wsID+"/members", nil, &gl)
	listed := map[string]bool{}
	for _, m := range gl.GetMembers() {
		listed[m.GetUser().GetId()] = true
	}
	for _, id := range []string{bob.id, b.id, o.id} {
		want := 404
		if listed[id] {
			want = 200
		}
		gus.must(want, "GET", path+id, nil, nil)
	}
	gus.must(200, "GET", path+gus.id, nil, &p)
	if len(p.GetOpenTasks()) != 0 {
		t.Fatalf("guest profile tasks: %v", p.GetOpenTasks())
	}
	// Renaming a member (already open): MANAGE_NICKNAMES, which the admin role carries.
	nick := "Бобби"
	b.must(200, "PATCH", path+bob.id, &v1.UpdateMemberRequest{Nickname: &nick}, nil)
}

// TestBotAPIv2Admin: invitations (INVITE_MEMBERS), badges (MANAGE_MEMBERS / MANAGE_NICKNAMES),
// sounds (MANAGE_STICKERS) and guest admission (INVITE_GUESTS): 403 without the bit, 2xx with it;
// account lookup and direct adding stay closed.
func TestBotAPIv2Admin(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	wsID, rid := ws.GetId(), room.GetId()
	b := createBot(t, o, wsID, "Helper")
	base := "/api/workspaces/" + wsID

	// Invitations.
	b.must(403, "GET", base+"/invites", nil, nil)
	b.must(403, "POST", base+"/invites", &v1.CreateInviteRequest{MaxUses: 1}, nil)
	b.must(403, "POST", base+"/invites/email", &v1.CreateEmailInviteRequest{Email: "x@outside.org"}, nil)
	if r, _ := errReason(b.client); r == "BOT_NOT_ALLOWED" {
		t.Fatal("email invites closed by the route table")
	}
	giveBot(t, o, wsID, b, "Inviter", perm.InviteMembers)
	var inv v1.CreateInviteResponse
	b.must(201, "POST", base+"/invites", &v1.CreateInviteRequest{MaxUses: 1}, &inv)
	if inv.GetInvite().GetCreatedBy() != b.id {
		t.Fatalf("invite: %v", inv.GetInvite())
	}
	b.must(200, "GET", base+"/invites", nil, nil)
	b.must(204, "DELETE", base+"/invites/"+inv.GetInvite().GetId(), nil, nil)
	addr := uniq("botinv") + "@outside.org"
	var ei v1.CreateEmailInviteResponse
	b.must(201, "POST", base+"/invites/email", &v1.CreateEmailInviteRequest{Email: addr}, &ei)
	admin := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	b.must(403, "POST", base+"/invites/email", &v1.CreateEmailInviteRequest{Email: uniq("a") + "@outside.org", Role: &admin}, nil)
	im := waitMail(t, addr, mail.TemplateWorkspaceInvite, 1)
	if inviter := im.Params["inviter"]; !strings.Contains(inviter, ws.GetName()) || !strings.Contains(inviter, "Helper") {
		t.Fatalf("bot invitation inviter: %q", inviter)
	}
	b.must(200, "GET", base+"/invites/email", nil, nil)
	b.must(204, "DELETE", base+"/invites/email/"+ei.GetInvite().GetId(), nil, nil)
	for _, call := range []struct{ method, path string }{{"POST", base + "/invites/lookup"}, {"POST", base + "/members"}} {
		b.must(403, call.method, call.path, &v1.InviteLookupRequest{Email: "x@outside.org"}, nil)
		if r, _ := errReason(b.client); r != "BOT_NOT_ALLOWED" {
			t.Fatalf("%s %s: %q", call.method, call.path, r)
		}
	}

	// Badges: the library by MANAGE_MEMBERS, a member's badge by MANAGE_NICKNAMES.
	bu := &user{client: b.client, id: b.id}
	pic := badgePicture(t, bu, wsID, noisePNG(t, 32, 32))
	b.must(403, "POST", base+"/badges", &v1.CreateBadgeRequest{Name: "Partner", FileId: pic}, nil)
	giveBot(t, o, wsID, b, "Members", perm.ManageMembers)
	var cb v1.CreateBadgeResponse
	b.must(201, "POST", base+"/badges", &v1.CreateBadgeRequest{Name: "Partner", FileId: pic}, &cb)
	name := "Partner+"
	b.must(200, "PATCH", base+"/badges/"+cb.GetBadge().GetId(), &v1.UpdateBadgeRequest{Name: &name}, nil)
	b.must(403, "PUT", base+"/members/"+bob.id+"/badge", &v1.SetMemberBadgeRequest{BadgeId: cb.GetBadge().GetId()}, nil)
	giveBot(t, o, wsID, b, "Nicknames", perm.ManageNicknames)
	var sm v1.SetMemberBadgeResponse
	b.must(200, "PUT", base+"/members/"+bob.id+"/badge", &v1.SetMemberBadgeRequest{BadgeId: cb.GetBadge().GetId()}, &sm)
	if sm.GetMember().GetBadgeId() != cb.GetBadge().GetId() {
		t.Fatalf("badge: %v", sm.GetMember())
	}
	b.must(403, "PUT", base+"/members/"+b.id+"/badge", &v1.SetMemberBadgeRequest{BadgeId: cb.GetBadge().GetId()}, nil) // bots have none
	b.must(204, "DELETE", base+"/badges/"+cb.GetBadge().GetId(), nil, nil)

	// Sounds: 403 without MANAGE_STICKERS (with it: TestSoundsLibrary).
	b.must(403, "POST", base+"/sounds", &v1.CreateSoundRequest{Name: "Tss", Emoji: "🥁", FileId: pic}, nil)
	if r, _ := errReason(b.client); r == "BOT_NOT_ALLOWED" {
		t.Fatal("sounds closed by the route table")
	}

	// Guest admission: INVITE_GUESTS in the room decides.
	setGuestApproval(t, o, rid, true)
	link := roomLink(t, o, rid, &v1.CreateRoomInviteRequest{})
	g1, _ := anonGuest(t, link.GetCode(), "Гость 1")
	admit := &v1.DecideRoomAdmissionRequest{Status: v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_ADMITTED}
	b.must(403, "POST", "/api/rooms/"+rid+"/admissions/"+g1.id, admit, nil)
	giveBot(t, o, wsID, b, "Guests", perm.InviteGuests)
	var dr v1.DecideRoomAdmissionResponse
	b.must(200, "POST", "/api/rooms/"+rid+"/admissions/"+g1.id, admit, &dr)
	if dr.GetAdmission().GetStatus() != v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_ADMITTED {
		t.Fatalf("bot admission: %v", dr.GetAdmission())
	}
	// A restricted room: 404, whatever the bits.
	secret := restrictedRoom(t, o, wsID, v1.RoomType_ROOM_TYPE_VOICE, "closed", bob.id)
	b.must(404, "POST", "/api/rooms/"+secret+"/admissions/"+g1.id, admit, nil)
}

// TestBotAPIv2Recording: a bot starts and stops a recording with MANAGE_RECORDINGS, 403 without.
func TestBotAPIv2Recording(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	pairWorkspace(t, o, ws.GetId())
	inCall(t, bob, ws, rid)
	b := createBot(t, o, ws.GetId(), "Recorder")
	b.must(403, "POST", "/api/rooms/"+rid+"/recording/start", nil, nil)
	if r, _ := errReason(b.client); r == "BOT_NOT_ALLOWED" {
		t.Fatal("recording closed by the route table")
	}
	giveBot(t, o, ws.GetId(), b, "Recordings", perm.ManageRecordings)
	var sr v1.StartRecordingResponse
	b.must(200, "POST", "/api/rooms/"+rid+"/recording/start", nil, &sr)
	if sr.GetRecording().GetByUserId() != b.id {
		t.Fatalf("started by: %v", sr.GetRecording())
	}
	// The stopped recording waits for its egress: take it out of the server-wide limit
	// (RECORDING_MAX_CONCURRENT) for the tests that follow.
	t.Cleanup(func() {
		if _, err := testDB.Pool.Exec(context.Background(), `UPDATE room_recordings SET status = 'failed' WHERE id = $1`,
			sr.GetRecording().GetRecordingId()); err != nil {
			t.Error(err)
		}
	})
	b.must(200, "POST", "/api/rooms/"+rid+"/recording/stop", nil, nil)
	secret := restrictedRoom(t, o, ws.GetId(), v1.RoomType_ROOM_TYPE_VOICE, "closed", bob.id)
	b.must(404, "POST", "/api/rooms/"+secret+"/recording/start", nil, nil)
}

// TestBotAPIv2Events: a bot's webhook gets task events of visible boards, meetings of visible
// rooms (without outside addresses) and member updates; nothing of a restricted board.
func TestBotAPIv2Events(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	b := createBot(t, c.o, wsID, "Listener")
	var (
		mu    sync.Mutex
		evs   []*v1.DispatchEvent
		dummy = httptest.NewTLSServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			var u v1.BotWebhookUpdate
			if err := protojson.Unmarshal(body, &u); err == nil {
				mu.Lock()
				evs = append(evs, u.GetEvent())
				mu.Unlock()
			}
		}))
	)
	defer dummy.Close()
	botHookCAs.AddCert(dummy.Certificate())
	b.must(200, "PUT", "/api/bots/me/webhook", &v1.SetBotWebhookRequest{Url: dummy.URL + "/hook", Secret: "0123456789abcdef-secret"}, nil)
	g := dialGW(t)
	g.identify(b.token)

	open := createBoard(t, c.o, wsID, &v1.CreateBoardRequest{Name: "Open"}, 201)
	closed := restrictedBoard(t, c.o, wsID, "Closed", c.bob.id)
	hiddenTask := createTask(t, c.o, closed.GetId(), &v1.CreateTaskRequest{Title: "Hidden"}, 201)
	task := createTask(t, c.o, open.GetId(), &v1.CreateTaskRequest{Title: "Seen"}, 201)
	partner := uniq("hook") + "@outside.org"
	start := time.Now().Add(48 * time.Hour).Truncate(time.Minute)
	meeting := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Hooked", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)),
		Tz: "UTC", RoomId: c.voice.GetId(), Attendees: []*v1.CalendarEventAttendeeInput{ext(partner)}})
	nick := "Боб"
	c.o.must(200, "PATCH", "/api/workspaces/"+wsID+"/members/"+c.bob.id, &v1.UpdateMemberRequest{Nickname: &nick}, nil)

	// Gateway.
	g.wait("TASK_CREATE", func(e *v1.DispatchEvent) bool { return e.GetTaskCreate().GetTask().GetId() == task.GetId() })
	ge := g.wait("EVENT_CREATE", func(e *v1.DispatchEvent) bool { return e.GetEventCreate().GetEvent().GetId() == meeting.GetId() })
	if a := attendeeOf(ge.GetEventCreate().GetEvent(), "", partner); a != nil {
		t.Fatalf("gateway: a bot gets an outside address: %v", a)
	}
	g.wait("WORKSPACE_MEMBER_UPDATE", func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceMemberUpdate().GetMember().GetNickname() == nick
	})

	// Webhook: the same, and nothing of the restricted board.
	deadline := time.Now().Add(8 * time.Second)
	var sawTask, sawEvent, sawMember bool
	for time.Now().Before(deadline) && (!sawTask || !sawEvent || !sawMember) {
		mu.Lock()
		cp := slices.Clone(evs)
		mu.Unlock()
		for _, e := range cp {
			if id := e.GetTaskCreate().GetTask().GetId(); id == hiddenTask.GetId() {
				t.Fatal("webhook: a task of a restricted board")
			} else if id == task.GetId() {
				sawTask = true
			}
			if ev := e.GetEventCreate().GetEvent(); ev.GetId() == meeting.GetId() {
				if attendeeOf(ev, "", partner) != nil || len(ev.GetAttendees()) == 0 {
					t.Fatalf("webhook: meeting attendees %v", ev.GetAttendees())
				}
				sawEvent = true
			}
			if e.GetWorkspaceMemberUpdate().GetMember().GetNickname() == nick {
				sawMember = true
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !sawTask || !sawEvent || !sawMember {
		t.Fatalf("webhook deliveries: task %v event %v member %v", sawTask, sawEvent, sawMember)
	}
	mu.Lock()
	for _, e := range evs {
		if e.GetTaskCreate().GetTask().GetId() == hiddenTask.GetId() || e.GetTaskActivity().GetActivity().GetTaskId() == hiddenTask.GetId() {
			t.Fatal("webhook: an event of a restricted board")
		}
	}
	mu.Unlock()
}
