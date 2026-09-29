//go:build integration

// Guest admission, the «waiting room» of room links (ADR-0040).
package app_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

var admissionIP = 0

// anonGuest joins by a link without an account from its own IP (the guest limit is per IP).
func anonGuest(t *testing.T, code, nick string) (*user, *v1.JoinRoomInviteResponse) {
	t.Helper()
	admissionIP++
	c := &client{t: t, ip: fmt.Sprintf("10.140.%d.%d", admissionIP/250, admissionIP%250+1)}
	var j v1.JoinRoomInviteResponse
	c.must(201, "POST", "/api/room-invites/"+code+"/join", &v1.JoinRoomInviteRequest{Nickname: nick}, &j)
	c.token = j.GetTokens().GetAccessToken()
	return &user{client: c, id: j.GetMe().GetUser().GetId()}, &j
}

func roomLink(t *testing.T, o *user, roomID string, req *v1.CreateRoomInviteRequest) *v1.RoomInvite {
	t.Helper()
	var r v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+roomID+"/invites", req, &r)
	return r.GetInvite()
}

func setGuestApproval(t *testing.T, o *user, roomID string, on bool) *v1.Room {
	t.Helper()
	var r v1.UpdateRoomResponse
	o.must(200, "PATCH", "/api/rooms/"+roomID, &v1.UpdateRoomRequest{GuestApproval: &on}, &r)
	if r.GetRoom().GetGuestApproval() != on {
		t.Fatalf("guest_approval: %v", r.GetRoom())
	}
	return r.GetRoom()
}

func decided(g *gw, roomID, userID string, st v1.RoomAdmissionStatus) *v1.RoomAdmission {
	g.t.Helper()
	return g.wait("ROOM_ADMISSION_DECIDED "+st.String(), func(e *v1.DispatchEvent) bool {
		a := e.GetRoomAdmissionDecided().GetAdmission()
		return a.GetRoomId() == roomID && a.GetUser().GetId() == userID && a.GetStatus() == st
	}).GetRoomAdmissionDecided().GetAdmission()
}

func isMember(t *testing.T, o *user, wsID, userID string) *v1.WorkspaceMember {
	t.Helper()
	var ms v1.ListMembersResponse
	o.must(200, "GET", "/api/workspaces/"+wsID+"/members", nil, &ms)
	for _, m := range ms.GetMembers() {
		if m.GetUser().GetId() == userID {
			return m
		}
	}
	return nil
}

func linkUses(t *testing.T, _ *user, _, inviteID string) uint32 {
	t.Helper()
	var n int32
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT uses FROM room_invites WHERE id = $1", inviteID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return uint32(n) //nolint:gosec // a count
}

// The room setting on → a guest knocks: pending READY without the room, no room / history /
// LiveKit token; the deciders are told and see the knock in READY; admitting with a name and
// a badge gives the room with the link's bits.
func TestGuestAdmissionAdmit(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	rid, wid := room.GetId(), ws.GetId()
	setGuestApproval(t, o, rid, true)
	inv := roomLink(t, o, rid, &v1.CreateRoomInviteRequest{})
	if inv.RequireApproval != nil {
		t.Fatalf("a new link inherits: %v", inv)
	}
	var pv v1.GetRoomInviteResponse
	(&client{t: t, ip: "10.140.200.1"}).must(200, "GET", "/api/room-invites/"+inv.GetCode(), nil, &pv)
	if !pv.GetRequiresApproval() {
		t.Fatalf("preview: %v", &pv)
	}
	og, bg := dialGW(t), dialGW(t)
	og.identify(o.token)
	bg.identify(bob.token)

	guest, j := anonGuest(t, inv.GetCode(), "Гость Аня")
	a := j.GetAdmission()
	if a.GetStatus() != v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_PENDING || a.GetRoomName() != "voice" || a.GetWorkspaceName() != ws.GetName() ||
		a.GetUser().GetId() != guest.id || a.GetInviteCreatedBy() != "" {
		t.Fatalf("join admission: %v", a)
	}
	req := og.wait("ROOM_ADMISSION_REQUEST", func(e *v1.DispatchEvent) bool {
		return e.GetRoomAdmissionRequest().GetAdmission().GetUser().GetId() == guest.id
	}).GetRoomAdmissionRequest().GetAdmission()
	if req.GetUser().GetDisplayName() != "Гость Аня" || req.GetInviteId() != inv.GetId() || req.GetInviteCreatedBy() != o.id || req.GetRoomId() != rid {
		t.Fatalf("request event: %v", req)
	}
	bg.quiet("admission request for a member without MANAGE_ROOM", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetRoomAdmissionRequest() != nil
	})
	if m := isMember(t, o, wid, guest.id); m.GetRole() != v1.WorkspaceRole_WORKSPACE_ROLE_GUEST {
		t.Fatalf("guest membership: %v", m)
	}

	// The waiting guest: READY with the knock and the workspace without rooms; no access.
	gg := dialGW(t)
	ready := gg.identify(guest.token)
	if pa := ready.GetPendingAdmissions(); len(pa) != 1 || pa[0].GetRoomId() != rid || pa[0].GetRoomName() != "voice" ||
		pa[0].GetStatus() != v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_PENDING {
		t.Fatalf("pending_admissions: %v", pa)
	}
	for _, s := range ready.GetWorkspaces() {
		if s.GetWorkspace().GetId() == wid && len(s.GetRooms()) != 0 {
			t.Fatalf("a waiting guest sees rooms: %v", s.GetRooms())
		}
	}
	guest.must(404, "GET", "/api/rooms/"+rid, nil, nil)
	guest.must(404, "GET", "/api/rooms/"+rid+"/messages?limit=10", nil, nil)
	guest.must(404, "POST", "/api/rooms/"+rid+"/join", nil, nil) // no LiveKit token
	guest.must(404, "GET", "/api/rooms/"+rid+"/admissions", nil, nil)

	// Knocking again while waiting (a reload): the same knock, no use consumed.
	uses := linkUses(t, o, rid, inv.GetId())
	var again v1.JoinRoomInviteResponse
	guest.must(200, "POST", "/api/room-invites/"+inv.GetCode()+"/join", &v1.JoinRoomInviteRequest{}, &again)
	if again.GetAdmission().GetStatus() != v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_PENDING || linkUses(t, o, rid, inv.GetId()) != uses {
		t.Fatalf("knock again: %v, uses %d → %d", again.GetAdmission(), uses, linkUses(t, o, rid, inv.GetId()))
	}

	// Deciders: the owner lists it and has it in READY; a member without MANAGE_ROOM and bots
	// cannot decide.
	var list v1.ListRoomAdmissionsResponse
	o.must(200, "GET", "/api/rooms/"+rid+"/admissions", nil, &list)
	if len(list.GetAdmissions()) != 1 || list.GetAdmissions()[0].GetUser().GetId() != guest.id {
		t.Fatalf("list: %v", &list)
	}
	found := false
	og = dialGW(t) // replaces the owner's session: READY again
	for _, s := range og.identify(o.token).GetWorkspaces() {
		for _, x := range s.GetAdmissions() {
			found = found || x.GetUser().GetId() == guest.id
		}
	}
	if !found {
		t.Fatal("decider READY without the knock")
	}
	admit := &v1.DecideRoomAdmissionRequest{Status: v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_ADMITTED}
	bob.must(403, "GET", "/api/rooms/"+rid+"/admissions", nil, nil)
	bob.must(403, "POST", "/api/rooms/"+rid+"/admissions/"+guest.id, admit, nil)
	b := createBot(t, o, wid, "Doorman")
	b.must(403, "GET", "/api/rooms/"+rid+"/admissions", nil, nil) // no MANAGE_ROOM
	b.must(403, "POST", "/api/rooms/"+rid+"/admissions/"+guest.id, admit, nil)
	if r, _ := errReason(b.client); r != "BOT_NOT_ALLOWED" {
		t.Fatalf("bot decide: %q", r)
	}
	o.must(422, "POST", "/api/rooms/"+rid+"/admissions/"+guest.id, &v1.DecideRoomAdmissionRequest{}, nil)
	long := strings.Repeat("я", 41)
	o.must(422, "POST", "/api/rooms/"+rid+"/admissions/"+guest.id, &v1.DecideRoomAdmissionRequest{Status: admit.Status, DisplayName: &long}, nil)
	foreign := "0190aaaa-0000-7000-8000-000000000000"
	o.must(422, "POST", "/api/rooms/"+rid+"/admissions/"+guest.id, &v1.DecideRoomAdmissionRequest{Status: admit.Status, BadgeId: &foreign}, nil)

	// Admit with a name and a badge.
	badge := newBadge(t, o, wid, "Партнёр", badgePicture(t, o, wid, noisePNG(t, 32, 32)))
	name := "  Анна (Ромашка) "
	var dr v1.DecideRoomAdmissionResponse
	o.must(200, "POST", "/api/rooms/"+rid+"/admissions/"+guest.id, &v1.DecideRoomAdmissionRequest{
		Status: admit.Status, DisplayName: &name, BadgeId: &badge.Id}, &dr)
	if dr.GetAdmission().GetStatus() != v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_ADMITTED || dr.GetAdmission().GetDecidedBy() != o.id ||
		dr.GetAdmission().GetUser().GetDisplayName() != "Анна (Ромашка)" {
		t.Fatalf("decide: %v", dr.GetAdmission())
	}
	// Two channels (the room by the workspace, the decision by the user): either order.
	var got *v1.RoomAdmission
	roomCreated := false
	for got == nil || !roomCreated {
		e := gg.wait("ROOM_CREATE and ROOM_ADMISSION_DECIDED", func(e *v1.DispatchEvent) bool {
			return e.GetRoomCreate().GetRoom().GetId() == rid || e.GetRoomAdmissionDecided() != nil
		})
		if a := e.GetRoomAdmissionDecided().GetAdmission(); a != nil {
			got = a
		} else {
			roomCreated = true
		}
	}
	if got.GetStatus() != v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_ADMITTED || got.GetRoomName() != "voice" || got.GetUser().GetId() != guest.id {
		t.Fatalf("guest's decided: %v", got)
	}
	decided(og, rid, guest.id, v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_ADMITTED)
	if bits, st := roomPerms(t, guest, rid); st != 200 || perm.Bits(bits) != perm.ViewRoom|perm.Connect|perm.Speak|perm.SendMessages {
		t.Fatalf("admitted guest bits %d (%d)", bits, st)
	}
	guest.must(200, "GET", "/api/rooms/"+rid+"/messages?limit=10", nil, nil)
	if m := isMember(t, o, wid, guest.id); m.GetUser().GetDisplayName() != "Анна (Ромашка)" || m.GetBadgeId() != badge.GetId() {
		t.Fatalf("admitted member: %v", m)
	}
	o.must(404, "POST", "/api/rooms/"+rid+"/admissions/"+guest.id, admit, nil) // decided already
	if len(dialGW(t).identify(guest.token).GetPendingAdmissions()) != 0 {
		t.Fatal("pending after admission")
	}
	// A member of the workspace never waits; nor does an admitted guest on the next visit.
	var mj v1.JoinRoomInviteResponse
	guest.must(200, "POST", "/api/room-invites/"+inv.GetCode()+"/join", &v1.JoinRoomInviteRequest{}, &mj)
	if mj.GetAdmission() != nil {
		t.Fatalf("admitted guest knocks again: %v", mj.GetAdmission())
	}
	private := textRoom(t, o, wid, "closed", true)
	setGuestApproval(t, o, private, true)
	pl := roomLink(t, o, private, &v1.CreateRoomInviteRequest{})
	bob.must(200, "POST", "/api/room-invites/"+pl.GetCode()+"/join", &v1.JoinRoomInviteRequest{}, &mj)
	if mj.GetAdmission() != nil {
		t.Fatalf("a member waits: %v", mj.GetAdmission())
	}
	bob.must(200, "GET", "/api/rooms/"+private, nil, nil)
}

// Declining: the knock is kept 10 minutes (no new knock meanwhile), the guest membership goes
// when the guest has no other room, the link's use comes back; nobody answering declines after
// 30 minutes with «no answer» (a new knock at once); the guest may cancel.
func TestGuestAdmissionDecline(t *testing.T) {
	o, _, ws, room := setupTeam(t)
	rid, wid := room.GetId(), ws.GetId()
	setGuestApproval(t, o, rid, true)
	inv := roomLink(t, o, rid, &v1.CreateRoomInviteRequest{MaxUses: 1})
	og := dialGW(t)
	og.identify(o.token)

	guest, _ := anonGuest(t, inv.GetCode(), "Незнакомец")
	gg := dialGW(t)
	gg.identify(guest.token)
	if linkUses(t, o, rid, inv.GetId()) != 1 {
		t.Fatal("a knock takes the link's use")
	}
	o.must(200, "POST", "/api/rooms/"+rid+"/admissions/"+guest.id, &v1.DecideRoomAdmissionRequest{Status: v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_DECLINED}, nil)
	if g := decided(gg, rid, guest.id, v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_DECLINED); g.GetNoAnswer() || g.GetDecidedBy() != o.id {
		t.Fatalf("declined: %v", g)
	}
	decided(og, rid, guest.id, v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_DECLINED)
	gg.wait("WORKSPACE_DELETE", func(e *v1.DispatchEvent) bool { return e.GetWorkspaceDelete().GetWorkspaceId() == wid })
	if isMember(t, o, wid, guest.id) != nil {
		t.Fatal("declined guest still a member")
	}
	if linkUses(t, o, rid, inv.GetId()) != 0 {
		t.Fatal("the use did not come back")
	}
	gg = dialGW(t) // replaces the guest's session: READY again
	if pa := gg.identify(guest.token).GetPendingAdmissions(); len(pa) != 1 || pa[0].GetStatus() != v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_DECLINED {
		t.Fatalf("declined knock in READY: %v", pa)
	}
	if st := guest.do("POST", "/api/room-invites/"+inv.GetCode()+"/join", &v1.JoinRoomInviteRequest{}, nil); st != 429 {
		t.Fatalf("knock within 10 min of a decline: %d", st)
	}
	if r, _ := errReason(guest.client); r != "ADMISSION_DECLINED" {
		t.Fatalf("reason %q", r)
	}

	// After 10 minutes the decline is gone: the guest knocks again.
	if _, err := testApp.Guests.SweepAdmissionsAt(context.Background(), time.Now().Add(11*time.Minute)); err != nil {
		t.Fatal(err)
	}
	var j v1.JoinRoomInviteResponse
	guest.must(200, "POST", "/api/room-invites/"+inv.GetCode()+"/join", &v1.JoinRoomInviteRequest{}, &j)
	if j.GetAdmission().GetStatus() != v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_PENDING {
		t.Fatalf("knock after the hold: %v", j.GetAdmission())
	}
	gg.wait("WORKSPACE_CREATE", func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceCreate().GetSnapshot().GetWorkspace().GetId() == wid
	})

	// Nobody answers for 30 minutes: declined with «no answer», the guest may knock at once.
	if _, err := testApp.Guests.SweepAdmissionsAt(context.Background(), time.Now().Add(29*time.Minute)); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT status FROM room_admissions WHERE room_id = $1 AND user_id = $2", rid, guest.id).Scan(&status); err != nil || status != "pending" {
		t.Fatalf("before 30 min: %q %v", status, err)
	}
	if n, err := testApp.Guests.SweepAdmissionsAt(context.Background(), time.Now().Add(31*time.Minute)); err != nil || n < 1 {
		t.Fatalf("sweep after 30 min: %d %v", n, err)
	}
	if g := decided(gg, rid, guest.id, v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_DECLINED); !g.GetNoAnswer() || g.GetDecidedBy() != "" {
		t.Fatalf("no answer: %v", g)
	}
	if a := decided(og, rid, guest.id, v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_DECLINED); !a.GetNoAnswer() {
		t.Fatalf("deciders' no answer: %v", a)
	}
	guest.must(200, "POST", "/api/room-invites/"+inv.GetCode()+"/join", &v1.JoinRoomInviteRequest{}, &j)
	if j.GetAdmission().GetStatus() != v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_PENDING {
		t.Fatalf("knock after no answer: %v", j.GetAdmission())
	}

	// The guest cancels: the deciders see CANCELLED, the membership goes.
	guest.must(204, "DELETE", "/api/rooms/"+rid+"/admissions/me", nil, nil)
	decided(og, rid, guest.id, v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_CANCELLED)
	guest.must(404, "DELETE", "/api/rooms/"+rid+"/admissions/me", nil, nil)
	if isMember(t, o, wid, guest.id) != nil || linkUses(t, o, rid, inv.GetId()) != 0 {
		t.Fatal("cancelled knock left the membership or the use")
	}
}

// The link's own setting beats the room's; PATCH switches it and back to inheriting; the
// author of a link without MANAGE_ROOM decides on its knocks only; ≤ 50 pending per room.
func TestGuestAdmissionLinkOverrideAndLimits(t *testing.T) {
	o, _, ws, room := setupTeam(t)
	rid, wid := room.GetId(), ws.GetId()
	setGuestApproval(t, o, rid, true)
	off, on := false, true
	open := roomLink(t, o, rid, &v1.CreateRoomInviteRequest{RequireApproval: &off})
	if open.RequireApproval == nil || open.GetRequireApproval() {
		t.Fatalf("link setting: %v", open)
	}
	g1, j := anonGuest(t, open.GetCode(), "Сразу")
	if j.GetAdmission() != nil {
		t.Fatalf("a link without approval makes a knock: %v", j.GetAdmission())
	}
	g1.must(200, "GET", "/api/rooms/"+rid, nil, nil)

	other := textRoom(t, o, wid, "open-room", false)
	strict := roomLink(t, o, other, &v1.CreateRoomInviteRequest{RequireApproval: &on})
	g2, j := anonGuest(t, strict.GetCode(), "С подтверждением")
	if j.GetAdmission().GetStatus() != v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_PENDING {
		t.Fatalf("a link with approval in a room without: %v", j.GetAdmission())
	}
	g2.must(404, "GET", "/api/rooms/"+other, nil, nil)

	// PATCH: back to the room's setting, and validation.
	var ur v1.UpdateRoomInviteResponse
	o.must(200, "PATCH", "/api/rooms/"+other+"/invites/"+strict.GetId(), &v1.UpdateRoomInviteRequest{InheritApproval: true}, &ur)
	if ur.GetInvite().RequireApproval != nil {
		t.Fatalf("inherit: %v", ur.GetInvite())
	}
	o.must(422, "PATCH", "/api/rooms/"+other+"/invites/"+strict.GetId(), &v1.UpdateRoomInviteRequest{InheritApproval: true, RequireApproval: &on}, nil)
	o.must(422, "PATCH", "/api/rooms/"+other+"/invites/"+strict.GetId(), &v1.UpdateRoomInviteRequest{}, nil)
	g1.must(403, "PATCH", "/api/rooms/"+rid+"/invites/"+open.GetId(), &v1.UpdateRoomInviteRequest{RequireApproval: &on}, nil)
	o.must(200, "PATCH", "/api/rooms/"+rid+"/invites/"+open.GetId(), &v1.UpdateRoomInviteRequest{InheritApproval: true}, &ur)
	_, j = anonGuest(t, open.GetCode(), "Теперь ждёт")
	if j.GetAdmission() == nil {
		t.Fatal("an inheriting link in a room with approval lets in")
	}

	// The author of a link without MANAGE_ROOM (an admin who made it, then demoted) decides
	// on its knocks only.
	mod := register(t, invite(t, o, wid))
	admin := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+mod.id, &v1.UpdateMemberRequest{Role: &admin}, nil)
	modLink := roomLink(t, mod, rid, &v1.CreateRoomInviteRequest{})
	member := v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+mod.id, &v1.UpdateMemberRequest{Role: &member}, nil)
	g3, _ := anonGuest(t, modLink.GetCode(), "Гость модератора")
	var list v1.ListRoomAdmissionsResponse
	mod.must(200, "GET", "/api/rooms/"+rid+"/admissions", nil, &list)
	if len(list.GetAdmissions()) != 1 || list.GetAdmissions()[0].GetUser().GetId() != g3.id {
		t.Fatalf("author's list: %v", &list)
	}
	o.must(200, "GET", "/api/rooms/"+rid+"/admissions", nil, &list)
	if len(list.GetAdmissions()) != 2 {
		t.Fatalf("manager's list: %d", len(list.GetAdmissions()))
	}
	someoneElse := list.GetAdmissions()[0].GetUser().GetId()
	if someoneElse == g3.id {
		someoneElse = list.GetAdmissions()[1].GetUser().GetId()
	}
	decline := &v1.DecideRoomAdmissionRequest{Status: v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_DECLINED}
	mod.must(403, "POST", "/api/rooms/"+rid+"/admissions/"+someoneElse, decline, nil)
	mod.must(200, "POST", "/api/rooms/"+rid+"/admissions/"+g3.id, &v1.DecideRoomAdmissionRequest{Status: v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_ADMITTED}, nil)
	g3.must(200, "GET", "/api/rooms/"+rid, nil, nil)

	// At most 50 pending per room: the 51st knock gets 429 ADMISSION_QUEUE_FULL.
	if _, err := testDB.Pool.Exec(context.Background(), `
		WITH g AS (
			INSERT INTO users (display_name, settings, is_guest, guest_expires_at)
			SELECT 'queue ' || i, '{}', true, now() + interval '1 day' FROM generate_series(1, 49) i
			RETURNING id)
		INSERT INTO room_admissions (room_id, user_id, invite_id) SELECT $1, id, $2 FROM g`, rid, open.GetId()); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM room_admissions WHERE room_id = $1 AND status = 'pending'", rid).Scan(&n)
	if n != 50 {
		t.Fatalf("pending %d, want 50", n)
	}
	admissionIP++
	c := &client{t: t, ip: fmt.Sprintf("10.140.%d.%d", admissionIP/250, admissionIP%250+1)}
	if st := c.do("POST", "/api/room-invites/"+open.GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Лишний"}, nil); st != 429 {
		t.Fatalf("51st knock: %d", st)
	}
	if r, _ := errReason(c); r != "ADMISSION_QUEUE_FULL" {
		t.Fatalf("reason %q", r)
	}
	if _, err := testDB.Pool.Exec(context.Background(), "DELETE FROM room_admissions WHERE room_id = $1", rid); err != nil {
		t.Fatal(err)
	}
}

// A meeting's guest link (ADR-0038) is made inheriting: the room's setting applies to it.
func TestGuestAdmissionMeetingLink(t *testing.T) {
	c := calSetup(t)
	wid, rid := c.ws.GetId(), c.voice.GetId()
	setGuestApproval(t, c.o, rid, true)
	start := time.Now().Add(72 * time.Hour).Truncate(time.Minute)
	createEvent(t, c.o, wid, &v1.CreateCalendarEventRequest{Title: "Демо", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)),
		Tz: "Europe/Moscow", RoomId: rid, Attendees: []*v1.CalendarEventAttendeeInput{ext(uniq("partner") + "@outside.org")}})
	var links v1.ListRoomInvitesResponse
	c.o.must(200, "GET", "/api/rooms/"+rid+"/invites", nil, &links)
	var link *v1.RoomInvite
	for _, l := range links.GetInvites() {
		if l.GetEventId() != "" {
			link = l
		}
	}
	if link == nil || link.RequireApproval != nil {
		t.Fatalf("meeting link: %v", link)
	}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE room_invites SET not_before = now() - interval '1 minute' WHERE id = $1", link.GetId()); err != nil {
		t.Fatal(err)
	}
	g, j := anonGuest(t, link.GetCode(), "Партнёр")
	if j.GetAdmission().GetStatus() != v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_PENDING {
		t.Fatalf("meeting guest: %v", j.GetAdmission())
	}
	// The organizer admits; the single-use link was used by the knock.
	c.o.must(200, "POST", "/api/rooms/"+rid+"/admissions/"+g.id, &v1.DecideRoomAdmissionRequest{Status: v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_ADMITTED}, nil)
	g.must(200, "GET", "/api/rooms/"+rid, nil, nil)
}
