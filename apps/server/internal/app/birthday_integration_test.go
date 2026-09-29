//go:build integration

package app_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

func bday(day, month uint32, year ...uint32) *v1.UpdateMeRequest {
	b := &v1.Birthday{Day: day, Month: month}
	if len(year) > 0 {
		b.Year = &year[0]
	}
	return &v1.UpdateMeRequest{Birthday: b}
}

func hideBirthday(v bool) *v1.UpdateMeRequest { return &v1.UpdateMeRequest{BirthdayHidden: &v} }

// memberUser is u as another member sees it in READY.
func memberUser(t *testing.T, viewer *user, wsID, userID string) *v1.User {
	t.Helper()
	for _, s := range dialGW(t).identify(viewer.token).GetWorkspaces() {
		if s.GetWorkspace().GetId() != wsID {
			continue
		}
		for _, m := range s.GetMembers() {
			if m.GetUser().GetId() == userID {
				return m.GetUser()
			}
		}
	}
	t.Fatalf("member %s not in READY", userID)
	return nil
}

// TestBirthdayMe: PATCH /api/me validates the birthday (29 February is fine, 30 February,
// a future year or a year alone are not), other members get it in USER_UPDATE and READY,
// a hidden birthday reaches nobody but its owner, day = month = 0 clears it.
func TestBirthdayMe(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	og := dialGW(t)
	og.identify(o.token)
	next := uint32(time.Now().Year() + 1) //nolint:gosec // test
	for _, bad := range []*v1.UpdateMeRequest{
		bday(30, 2), bday(31, 4), bday(0, 3), bday(1, 13), bday(29, 2, 2023), bday(1, 1, 1899), bday(1, 1, next),
		{Birthday: &v1.Birthday{Year: func() *uint32 { y := uint32(1990); return &y }()}}, // a year alone
	} {
		bob.must(422, "PATCH", "/api/me", bad, nil)
	}
	var me v1.UpdateMeResponse
	bob.must(200, "PATCH", "/api/me", bday(29, 2), &me)
	if b := me.GetMe().GetUser().GetBirthday(); b.GetDay() != 29 || b.GetMonth() != 2 || b.Year != nil {
		t.Fatalf("29 February: %v", b)
	}
	bob.must(200, "PATCH", "/api/me", bday(15, 3, 1990), &me)
	if b := me.GetMe().GetUser().GetBirthday(); b.GetDay() != 15 || b.GetMonth() != 3 || b.GetYear() != 1990 || me.GetMe().GetBirthdayHidden() {
		t.Fatalf("response: %v", me.GetMe())
	}
	og.wait("USER_UPDATE with the birthday", func(e *v1.DispatchEvent) bool {
		u := e.GetUserUpdate().GetUser()
		return u.GetId() == bob.id && u.GetBirthday().GetDay() == 15 && u.GetBirthday().GetYear() == 1990
	})
	if u := memberUser(t, o, ws.GetId(), bob.id); u.GetBirthday().GetMonth() != 3 {
		t.Fatalf("READY member: %v", u)
	}

	// Hidden: the owner still has it (with the flag), nobody else does.
	og = dialGW(t) // READY above replaced the session
	og.identify(o.token)
	bob.must(200, "PATCH", "/api/me", hideBirthday(true), &me)
	if !me.GetMe().GetBirthdayHidden() || me.GetMe().GetUser().GetBirthday().GetDay() != 15 {
		t.Fatalf("own hidden birthday: %v", me.GetMe())
	}
	og.wait("USER_UPDATE without the birthday", func(e *v1.DispatchEvent) bool {
		u := e.GetUserUpdate().GetUser()
		return u.GetId() == bob.id && u.Birthday == nil
	})
	if u := memberUser(t, o, ws.GetId(), bob.id); u.Birthday != nil {
		t.Fatalf("hidden birthday in READY: %v", u.GetBirthday())
	}
	var members v1.ListMembersResponse
	o.must(200, "GET", "/api/workspaces/"+ws.GetId()+"/members", nil, &members)
	for _, m := range members.GetMembers() {
		if m.GetUser().GetId() == bob.id && m.GetUser().Birthday != nil {
			t.Fatal("hidden birthday in the member list")
		}
	}
	var got v1.GetMeResponse
	bob.must(200, "GET", "/api/me", nil, &got)
	if got.GetMe().GetUser().GetBirthday().GetDay() != 15 || !got.GetMe().GetBirthdayHidden() {
		t.Fatalf("GET /api/me: %v", got.GetMe())
	}
	bob.must(200, "PATCH", "/api/me", hideBirthday(false), nil)
	if u := memberUser(t, o, ws.GetId(), bob.id); u.GetBirthday().GetDay() != 15 {
		t.Fatal("shown again: missing")
	}

	// Clear.
	bob.must(200, "PATCH", "/api/me", bday(0, 0), &me)
	if me.GetMe().GetUser().Birthday != nil {
		t.Fatalf("not cleared: %v", me.GetMe().GetUser().GetBirthday())
	}
}

// birthdayCards lists the birthday cards of userID in a room.
func birthdayCards(t *testing.T, viewer *user, roomID, userID string) []*v1.Message {
	t.Helper()
	var list v1.ListMessagesResponse
	viewer.must(200, "GET", "/api/rooms/"+roomID+"/messages?limit=50", nil, &list)
	var out []*v1.Message
	for _, m := range list.GetMessages() {
		if m.GetKind() == v1.MessageKind_MESSAGE_KIND_SYSTEM && m.GetSystem().GetBirthday() != nil && m.GetAuthorId() == userID {
			out = append(out, m)
		}
	}
	return out
}

func bdRoom(t *testing.T, o *user, wsID, name string, private bool, category string) string {
	t.Helper()
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wsID+"/rooms", &v1.CreateRoomRequest{
		Type: v1.RoomType_ROOM_TYPE_TEXT, Name: name, IsPrivate: private, CategoryId: category,
	}, &cr)
	return cr.GetRoom().GetId()
}

// TestBirthdayWorker: the card goes at 09:00 of the celebrant's zone into the first public
// text room of every shared workspace (MESSAGE_CREATE), once per day (dedup across runs), not
// before 09:00, not the next day, not for a hidden birthday, not into a workspace of one.
func TestBirthdayWorker(t *testing.T) {
	ctx := context.Background()
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	// Sidebar order: the private room and the category room come first by creation, but the
	// card goes to the first public top-level text room.
	bdRoom(t, o, wid, "secret", true, "")
	var cat v1.CreateCategoryResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/categories", &v1.CreateCategoryRequest{Name: "Work"}, &cat)
	inCat := bdRoom(t, o, wid, "in-category", false, cat.GetCategory().GetId())
	general := bdRoom(t, o, wid, "general", false, "")
	later := bdRoom(t, o, wid, "later", false, "")
	// A second shared workspace and bob's own one (nobody else there).
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	register2 := invite(t, o, ws2.GetId())
	bob.must(200, "POST", "/api/invites/"+register2+"/join", nil, nil)
	general2 := bdRoom(t, o, ws2.GetId(), "general", false, "")
	own := createWorkspace(t, bob, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	ownRoom := bdRoom(t, bob, own.GetId(), "mine", false, "")

	// A date far from today, so the real-time worker of the test server never matches it.
	tokyo, _ := time.LoadLocation("Asia/Tokyo")
	d := time.Now().AddDate(0, 0, 150).In(tokyo)
	tz := "Asia/Tokyo"
	bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Timezone: &tz,
		Birthday: &v1.Birthday{Day: uint32(d.Day()), Month: uint32(d.Month())}}, nil) //nolint:gosec // test
	at := func(hour, minute int) time.Time {
		return time.Date(d.Year(), d.Month(), d.Day(), hour, minute, 0, 0, tokyo)
	}
	og := dialGW(t)
	og.identify(o.token)

	// 08:59 in Tokyo: not yet (it is 23:59 the day before in UTC, too).
	if _, err := testApp.Birthdays.Greet(ctx, at(8, 59)); err != nil {
		t.Fatal(err)
	}
	if n := len(birthdayCards(t, o, general, bob.id)); n != 0 {
		t.Fatalf("card before 09:00: %d", n)
	}
	// 09:05: a card in general and in general of ws2, none in the other rooms or bob's own.
	if _, err := testApp.Birthdays.Greet(ctx, at(9, 5)); err != nil {
		t.Fatal(err)
	}
	ev := og.wait("MESSAGE_CREATE of the birthday card", func(e *v1.DispatchEvent) bool {
		m := e.GetMessageCreate().GetMessage()
		return m.GetSystem().GetBirthday() != nil && m.GetAuthorId() == bob.id
	})
	if c := ev.GetMessageCreate().GetMessage().GetSystem().GetBirthday(); c.GetDay() != uint32(d.Day()) || c.GetMonth() != uint32(d.Month()) { //nolint:gosec // test
		t.Fatalf("card: %v", c)
	}
	for room, want := range map[string]int{general: 1, general2: 1, inCat: 0, later: 0} {
		if n := len(birthdayCards(t, o, room, bob.id)); n != want {
			t.Errorf("room %s: %d cards, want %d", room, n, want)
		}
	}
	if n := len(birthdayCards(t, bob, ownRoom, bob.id)); n != 0 {
		t.Errorf("card in a workspace of one: %d", n)
	}
	// Later the same day and next hour runs: no second card. The next day: none either.
	for _, now := range []time.Time{at(10, 5), at(23, 30), at(9, 5).AddDate(0, 0, 1)} {
		if _, err := testApp.Birthdays.Greet(ctx, now); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(birthdayCards(t, o, general, bob.id)); n != 1 {
		t.Fatalf("dedup: %d cards", n)
	}

	// Without a time zone the day is UTC's; a hidden birthday gets no card.
	carol := register(t, invite(t, o, wid))
	u := time.Now().AddDate(0, 0, 200).UTC()
	carol.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Birthday: &v1.Birthday{Day: uint32(u.Day()), Month: uint32(u.Month())}, BirthdayHidden: func() *bool { b := true; return &b }()}, nil) //nolint:gosec // test
	noon := time.Date(u.Year(), u.Month(), u.Day(), 12, 0, 0, 0, time.UTC)
	if _, err := testApp.Birthdays.Greet(ctx, noon); err != nil {
		t.Fatal(err)
	}
	if n := len(birthdayCards(t, o, general, carol.id)); n != 0 {
		t.Fatalf("hidden birthday got %d cards", n)
	}
	carol.must(200, "PATCH", "/api/me", hideBirthday(false), nil)
	if _, err := testApp.Birthdays.Greet(ctx, time.Date(u.Year(), u.Month(), u.Day(), 8, 30, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	if n := len(birthdayCards(t, o, general, carol.id)); n != 0 {
		t.Fatalf("UTC 08:30: %d cards", n)
	}
	if _, err := testApp.Birthdays.Greet(ctx, noon); err != nil {
		t.Fatal(err)
	}
	if n := len(birthdayCards(t, o, general, carol.id)); n != 1 {
		t.Fatalf("UTC noon: %d cards, want 1", n)
	}

	// Without a zone of one's own, the workspace owner's zone decides: a Moscow team gets the
	// card at 09:00 MSK (06:00 UTC), not at 09:00 UTC.
	msk := "Europe/Moscow"
	o.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Timezone: &msk}, nil)
	dave := register(t, invite(t, o, wid))
	v := time.Now().AddDate(0, 0, 250).UTC()
	dave.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Birthday: &v1.Birthday{Day: uint32(v.Day()), Month: uint32(v.Month())}}, nil) //nolint:gosec // test
	for _, c := range []struct {
		hour, want int
	}{{5, 0}, {6, 1}} { // 08:xx MSK: not yet; 09:xx MSK: the card
		if _, err := testApp.Birthdays.Greet(ctx, time.Date(v.Year(), v.Month(), v.Day(), c.hour, 30, 0, 0, time.UTC)); err != nil {
			t.Fatal(err)
		}
		if n := len(birthdayCards(t, o, general, dave.id)); n != c.want {
			t.Fatalf("%02d:30 UTC with an owner in Moscow: %d cards, want %d", c.hour, n, c.want)
		}
	}
}

// TestBirthdaysUpcoming: GET /api/workspaces/{id}/birthdays?days= lists members' birthdays in
// the next days (the caller's today), soonest first, without hidden ones; 422 on a bad
// `days`, 404 for outsiders, 403 for guests.
func TestBirthdaysUpcoming(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	code := invite(t, o, wid)
	carol, dave, eve, guest := register(t, code), register(t, code), register(t, code), register(t, code)
	guestRole := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+guest.id, &v1.UpdateMemberRequest{Role: &guestRole}, nil)
	// o has no time zone: today is UTC's. Stay clear of midnight UTC.
	today := time.Now().UTC()
	if today.Hour() == 23 && today.Minute() > 55 {
		time.Sleep(6 * time.Minute)
		today = time.Now().UTC()
	}
	on := func(u *user, days int, year ...uint32) {
		d := today.AddDate(0, 0, days)
		u.must(200, "PATCH", "/api/me", bday(uint32(d.Day()), uint32(d.Month()), year...), nil) //nolint:gosec // test
	}
	on(bob, 0)
	on(carol, 3, 1990)
	on(dave, 10)
	on(eve, 1)
	eve.must(200, "PATCH", "/api/me", hideBirthday(true), nil)

	list := func(q string) []string {
		var r v1.ListBirthdaysResponse
		o.must(200, "GET", "/api/workspaces/"+wid+"/birthdays"+q, nil, &r)
		var out []string
		for _, b := range r.GetBirthdays() {
			out = append(out, fmt.Sprintf("%s:%d", b.GetUserId(), b.GetInDays()))
		}
		return out
	}
	want := []string{bob.id + ":0", carol.id + ":3"}
	if got := list(""); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("7 days: %v, want %v", got, want)
	}
	if got := list("?days=31"); len(got) != 3 || got[2] != dave.id+":10" {
		t.Fatalf("31 days: %v", got)
	}
	var r v1.ListBirthdaysResponse
	o.must(200, "GET", "/api/workspaces/"+wid+"/birthdays?days=7", nil, &r)
	for _, b := range r.GetBirthdays() {
		if b.GetUserId() == carol.id && b.GetBirthday().GetYear() != 1990 {
			t.Fatalf("carol: %v", b.GetBirthday())
		}
	}
	for _, q := range []string{"?days=0", "?days=32", "?days=x"} {
		o.must(422, "GET", "/api/workspaces/"+wid+"/birthdays"+q, nil, nil)
	}
	outsider(t).must(404, "GET", "/api/workspaces/"+wid+"/birthdays", nil, nil)
	guest.must(403, "GET", "/api/workspaces/"+wid+"/birthdays", nil, nil)
}

// TestBirthdayByAdmin (docs/09 #77): PATCH …/members/{id}/birthday needs MANAGE_NICKNAMES and
// the kick hierarchy (a custom role reaches only members below it, an admin not the owner);
// bots and guests have no birthday; USER_UPDATE goes out; a birthday its owner hid stays hidden
// from everyone else (READY, GET …/birthdays) while the admin table shows it marked.
func TestBirthdayByAdmin(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	alice := register(t, invite(t, o, wid))
	carol := register(t, invite(t, o, wid))
	dave := register(t, invite(t, o, wid))
	admin := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+carol.id, &v1.UpdateMemberRequest{Role: &admin}, nil)
	nicks := newRole(t, o, wid, "Nicks", perm.ManageNicknames)
	if st, _ := setMemberRoles(o, wid, dave.id, nicks.GetId()); st != 200 {
		t.Fatalf("give the role: %d", st)
	}
	path := func(uid string) string { return "/api/workspaces/" + wid + "/members/" + uid + "/birthday" }
	list := "/api/workspaces/" + wid + "/members/birthdays"
	// Far from today: the real-time worker of the test server never posts a card for it.
	d := time.Now().AddDate(0, 0, 150)
	day, month := uint32(d.Day()), uint32(d.Month()) //nolint:gosec // test
	set := func(day, month uint32, year ...uint32) *v1.UpdateMemberBirthdayRequest {
		return &v1.UpdateMemberBirthdayRequest{Birthday: bday(day, month, year...).GetBirthday()}
	}

	// Rights and hierarchy.
	bob.must(403, "PATCH", path(alice.id), set(day, month), nil) // no MANAGE_NICKNAMES
	bob.must(403, "GET", list, nil, nil)
	dave.must(403, "PATCH", path(carol.id), set(day, month), nil) // an admin is above the custom role
	dave.must(403, "PATCH", path(o.id), set(day, month), nil)
	carol.must(403, "PATCH", path(o.id), set(day, month), nil) // the owner is above an admin
	o.must(200, "PATCH", path(carol.id), set(day, month), nil)
	o.must(404, "PATCH", path("00000000-0000-0000-0000-000000000001"), set(day, month), nil)
	dave.must(422, "PATCH", path(bob.id), set(30, 2), nil)

	// Set by the custom role: USER_UPDATE to the workspace (User) and to bob (Me).
	ag, bg := dialGW(t), dialGW(t)
	ag.identify(alice.token)
	bg.identify(bob.token)
	var resp v1.UpdateMemberBirthdayResponse
	dave.must(200, "PATCH", path(bob.id), set(day, month, 1991), &resp)
	if b := resp.GetBirthday(); b.GetUserId() != bob.id || b.GetBirthday().GetDay() != day || b.GetBirthday().GetYear() != 1991 || b.GetHidden() {
		t.Fatalf("response: %v", b)
	}
	ag.wait("USER_UPDATE with bob's birthday", func(e *v1.DispatchEvent) bool {
		u := e.GetUserUpdate().GetUser()
		return u.GetId() == bob.id && u.GetBirthday().GetDay() == day && u.GetBirthday().GetMonth() == month
	})
	bg.wait("USER_UPDATE {me} with the birthday", func(e *v1.DispatchEvent) bool {
		return e.GetUserUpdate().GetMe().GetUser().GetBirthday().GetYear() == 1991
	})

	// Hidden by bob: an admin still changes it (200), it stays hidden for others.
	bob.must(200, "PATCH", "/api/me", hideBirthday(true), nil)
	o.must(200, "PATCH", path(bob.id), set(day, month), &resp)
	if !resp.GetBirthday().GetHidden() || resp.GetBirthday().GetBirthday().Year != nil {
		t.Fatalf("hidden response: %v", resp.GetBirthday())
	}
	if u := memberUser(t, alice, wid, bob.id); u.Birthday != nil {
		t.Fatalf("hidden birthday in READY: %v", u.GetBirthday())
	}
	var up v1.ListBirthdaysResponse
	alice.must(200, "GET", "/api/workspaces/"+wid+"/birthdays?days=31", nil, &up)
	for _, b := range up.GetBirthdays() {
		if b.GetUserId() == bob.id {
			t.Fatal("hidden birthday in GET …/birthdays")
		}
	}
	var me v1.GetMeResponse
	bob.must(200, "GET", "/api/me", nil, &me)
	if !me.GetMe().GetBirthdayHidden() || me.GetMe().GetUser().GetBirthday().GetDay() != day || me.GetMe().GetUser().GetBirthday().Year != nil {
		t.Fatalf("bob's own: %v", me.GetMe())
	}
	var tbl v1.ListMemberBirthdaysResponse
	dave.must(200, "GET", list, nil, &tbl)
	got := map[string]*v1.MemberBirthday{}
	for _, b := range tbl.GetBirthdays() {
		got[b.GetUserId()] = b
	}
	if b := got[bob.id]; b == nil || !b.GetHidden() || b.GetBirthday().GetMonth() != month {
		t.Fatalf("admin table, bob: %v", b)
	}
	if b := got[carol.id]; b == nil || b.GetHidden() {
		t.Fatalf("admin table, carol: %v", b)
	}
	if got[alice.id] != nil {
		t.Fatal("alice has no birthday")
	}

	// Clear: an empty body.
	o.must(200, "PATCH", path(bob.id), &v1.UpdateMemberBirthdayRequest{}, &resp)
	if resp.GetBirthday().Birthday != nil {
		t.Fatalf("not cleared: %v", resp.GetBirthday())
	}

	// Bots: no birthday for them, and a bot token may not set one (BOT_NOT_ALLOWED).
	b := createBot(t, o, wid, "Bday")
	o.must(403, "PATCH", path(b.id), set(day, month), nil)
	b.must(403, "PATCH", path(bob.id), set(day, month), nil)
	if reason, _ := errReason(b.client); reason != "BOT_NOT_ALLOWED" {
		t.Fatalf("bot token: reason %q", reason)
	}
	b.must(403, "GET", list, nil, nil)

	// Guests: none either.
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+alice.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	o.must(403, "PATCH", path(alice.id), set(day, month), nil)
}
