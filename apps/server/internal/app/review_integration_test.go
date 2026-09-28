//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/perm"
)

// instance is an extra app (own gateway hub) on the shared DB / Redis.
type instance struct {
	app  *app.App
	srv  *httptest.Server
	stop context.CancelFunc
}

func newInstance(t *testing.T) *instance {
	t.Helper()
	a := app.New(app.Deps{Config: testCfg, DB: testDB, Redis: testRedis, Events: events.Redis{C: testRedis}, Blob: testStore, LiveKit: lkRec})
	ctx, cancel := context.WithCancel(context.Background())
	a.Run(ctx)
	s := httptest.NewServer(a.Handler)
	t.Cleanup(func() { s.Close(); cancel() })
	time.Sleep(150 * time.Millisecond) // pub/sub subscribed
	return &instance{app: a, srv: s, stop: cancel}
}

func dialAt(t *testing.T, base string) *gw {
	old := srv.URL
	srv.URL = base
	defer func() { srv.URL = old }()
	return dialGW(t)
}

// H1: RESUME never silently loses events: a live owner hands the session over (the gap is
// replayed); a session released on shutdown is answered with INVALID_SESSION.
func TestResumeAcrossInstances(t *testing.T) {
	o, bob, _, room := setupTeam(t)
	a, b := newInstance(t), newInstance(t)

	// Live handoff: bob on A, drops; message in the gap; RESUME on B → replayed.
	g := dialAt(t, a.srv.URL)
	ready := g.identify(bob.token)
	last := g.last
	_ = g.ws.CloseNow()
	time.Sleep(100 * time.Millisecond)
	gap := send(t, o, room.GetId(), "sent while bob was switching instances", "")
	time.Sleep(150 * time.Millisecond)
	g2 := dialAt(t, b.srv.URL)
	g2.last = last
	g2.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_RESUME, Payload: &v1.GatewayFrame_Resume{Resume: &v1.Resume{
		Token: bob.token, SessionId: ready.GetSessionId(), Seq: last}}})
	got := false
	g2.wait("RESUMED on B", func(e *v1.DispatchEvent) bool {
		got = got || e.GetMessageCreate().GetMessage().GetId() == gap.GetId()
		return e.GetResumed() != nil
	})
	if !got {
		t.Fatal("event published during the handoff was lost")
	}
	live := send(t, o, room.GetId(), "after handoff", "")
	g2.wait("live on B", func(e *v1.DispatchEvent) bool { return e.GetMessageCreate().GetMessage().GetId() == live.GetId() })

	// Shutdown: B releases the session (RECONNECT reaches the client), an event is published,
	// RESUME on A → INVALID_SESSION (nobody buffered the gap), IDENTIFY works.
	last = g2.last
	go b.app.Gateway.Shutdown(context.Background())
	g2.waitFrame("RECONNECT", func(f *v1.GatewayFrame) bool { return f.GetReconnect() != nil })
	send(t, o, room.GetId(), "after shutdown", "")
	g3 := dialAt(t, a.srv.URL)
	g3.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_RESUME, Payload: &v1.GatewayFrame_Resume{Resume: &v1.Resume{
		Token: bob.token, SessionId: ready.GetSessionId(), Seq: last}}})
	inv := g3.waitFrame("INVALID_SESSION", func(f *v1.GatewayFrame) bool {
		return f.GetInvalidSession() != nil || f.GetDispatch().GetResumed() != nil
	})
	if inv.GetInvalidSession() == nil || inv.GetInvalidSession().GetResumable() {
		t.Fatalf("RESUME after shutdown: %v (want INVALID_SESSION)", inv)
	}
	g3.identify(bob.token)
}

// H2: a LiveKit join is re-validated at participant_joined; the user limit is atomic.
func TestJoinRevalidation(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	alice := register(t, invite(t, o, ws.GetId()))
	wid, rid := ws.GetId(), room.GetId()
	lkName := "ws_" + wid + "_room_" + rid
	var bj, aj v1.JoinVoiceResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &bj)
	alice.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &aj)

	// Bob loses CONNECT after getting his token: the join is rejected and he is removed.
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Deny: uint64(perm.Connect)},
	}}, nil)
	webhook(t, whEvent("participant_joined", lkName, bj.GetIdentity(), nil), "secret")
	time.Sleep(50 * time.Millisecond)
	if !lkRec.wasRemoved(bj.GetIdentity()) || inVoice(t, o, bob.id, rid) {
		t.Fatal("participant without CONNECT was admitted")
	}
	// Kicked member.
	o.must(204, "DELETE", "/api/workspaces/"+wid+"/members/"+alice.id, nil, nil)
	webhook(t, whEvent("participant_joined", lkName, aj.GetIdentity(), nil), "secret")
	time.Sleep(50 * time.Millisecond)
	if !lkRec.wasRemoved(aj.GetIdentity()) {
		t.Fatal("kicked member was admitted")
	}

	// c3 gets a token for the room while it has no limit, then goes to another room: its
	// token outlives its (pending) place here.
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{}, nil)
	c3 := register(t, invite(t, o, wid))
	var j3 v1.JoinVoiceResponse
	c3.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &j3)
	var other v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "other"}, &other)
	c3.must(200, "POST", "/api/rooms/"+other.GetRoom().GetId()+"/join", nil, nil)

	// user_limit=1 with two concurrent /joins: exactly one gets the place (the optimistic
	// pending state is written under the voice lock with the limit check).
	one := uint32(1)
	o.must(200, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{UserLimit: &one}, nil)
	c1 := register(t, invite(t, o, wid))
	c2 := register(t, invite(t, o, wid))
	var j1, j2 v1.JoinVoiceResponse
	var st1, st2 int
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); st1 = c1.do("POST", "/api/rooms/"+rid+"/join", nil, &j1) }()
	go func() { defer wg.Done(); st2 = c2.do("POST", "/api/rooms/"+rid+"/join", nil, &j2) }()
	wg.Wait()
	if (st1 == 200) == (st2 == 200) || st1+st2 != 200+409 {
		t.Fatalf("user_limit=1 with concurrent /joins: %d, %d (want exactly one 200, the other 409)", st1, st2)
	}
	winner, id := c1, j1.GetIdentity()
	if st2 == 200 {
		winner, id = c2, j2.GetIdentity()
	}
	webhook(t, whEvent("participant_joined", lkName, id, nil), "secret")
	if !inVoice(t, o, winner.id, rid) {
		t.Fatal("the member who got the place was not admitted")
	}
	// The stale token is re-checked at participant_joined: the room is full → removed; c3
	// stays where it is now.
	webhook(t, whEvent("participant_joined", lkName, j3.GetIdentity(), nil), "secret")
	time.Sleep(50 * time.Millisecond)
	if !lkRec.wasRemoved(j3.GetIdentity()) || inVoice(t, o, c3.id, rid) || !inVoice(t, o, c3.id, other.GetRoom().GetId()) {
		t.Fatal("a join over user_limit was admitted (or took the device out of its current room)")
	}
}

func inVoice(t *testing.T, u *user, userID, roomID string) bool {
	t.Helper()
	for _, s := range dialGW(t).identify(u.token).GetWorkspaces() {
		for _, vs := range s.GetVoiceStates() {
			if vs.GetUserId() == userID && vs.GetRoomId() == roomID {
				return true
			}
		}
	}
	return false
}

// M5 + M6: reconcile keeps fresh joins; webhook retries after a failure are processed;
// late track events do not resurrect state.
func TestReconcileAndWebhookRetry(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	wid, rid := ws.GetId(), room.GetId()
	lkName := "ws_" + wid + "_room_" + rid
	// Late track event without participant (no /join either): no ghost state.
	webhook(t, whEvent("track_published", lkName, bob.id+":"+bob.session, nil), "secret")
	if inVoice(t, o, bob.id, rid) {
		t.Fatal("late track event created voice state")
	}
	var bj v1.JoinVoiceResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &bj)

	// Webhook failure (voice lock held beyond the 3 s wait) → retry of the same event works.
	ev := whEvent("participant_joined", lkName, bj.GetIdentity(), nil)
	_ = testRedis.Do(context.Background(), testRedis.B().Set().Key("voice:lock:"+wid).Value("x").Px(3500*time.Millisecond).Build()).Error()
	if st := webhook(t, ev, "secret"); st < 500 {
		t.Fatalf("webhook during lock: %d, want 5xx", st)
	}
	time.Sleep(700 * time.Millisecond)
	if st := webhook(t, ev, "secret"); st != 200 || !inVoice(t, o, bob.id, rid) {
		t.Fatalf("retry after failure not processed: %d", st)
	}

	// Reconcile: bob is not really in LiveKit, but the join is fresh → kept; once older than
	// the grace window → removed.
	reconcile := func() { runReconcile(t) } // pauses the harness's reconcile-lock holder
	reconcile()
	if !inVoice(t, o, bob.id, rid) {
		t.Fatal("reconcile removed a fresh join")
	}
	key := "voice:ws:" + wid
	raw, _ := testRedis.Do(context.Background(), testRedis.B().Hget().Key(key).Field(bj.GetIdentity()).Build()).ToString()
	var st map[string]any
	if err := json.Unmarshal([]byte(raw), &st); err != nil {
		t.Fatalf("voice state %q: %v", raw, err)
	}
	st["j"] = 1 // joined long ago
	old, _ := json.Marshal(st)
	_ = testRedis.Do(context.Background(), testRedis.B().Hset().Key(key).FieldValue().FieldValue(bj.GetIdentity(), string(old)).Build()).Error()
	reconcile()
	if inVoice(t, o, bob.id, rid) {
		t.Fatal("reconcile kept a stale participant")
	}
}

// M1, M7, M8, M11, M12, L4, L6, L9, L13, M3.
func TestReviewFixes(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	wid, rid := ws.GetId(), room.GetId()

	// M11: over-long edit is a validation error, not a 500.
	m := send(t, bob, rid, "short", "")
	bob.must(422, "PATCH", "/api/messages/"+m.GetId(), &v1.UpdateMessageRequest{Content: strings.Repeat("x", 4001)}, nil)

	// M1: web refresh race. The other tab with the old cookie gets the same new cookie
	// (docs/09 #89); without the replay entry it is 409 and the cookie is kept (no Max-Age=-1).
	email := mustEmail(t, o)
	r := webPost(t, "/api/auth/login", &v1.LoginRequest{Email: email, Password: "password123"}, goodOrigin, "")
	first := r.cookie.Value
	r = webPost(t, "/api/auth/refresh", nil, goodOrigin, first)
	if r.status != 200 {
		t.Fatalf("refresh: %d", r.status)
	}
	second := r.cookie.Value
	r = webPost(t, "/api/auth/refresh", nil, goodOrigin, first) // the other tab, old cookie
	if r.status != 200 || r.cookie == nil || r.cookie.Value != second {
		t.Fatalf("race: %d cookie=%+v (want 200 with the same new cookie)", r.status, r.cookie)
	}
	sid, _, _ := strings.Cut(second, ".")
	_ = testRedis.Do(context.Background(), testRedis.B().Del().Key("auth:refresh_replay:"+sid).Build()).Error()
	r = webPost(t, "/api/auth/refresh", nil, goodOrigin, first)
	if r.status != 409 || r.cookie != nil {
		t.Fatalf("race without replay: %d cookie=%+v (want 409 without Set-Cookie)", r.status, r.cookie)
	}

	// Guest via room link.
	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+rid+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	var gj v1.JoinRoomInviteResponse
	(&client{t: t, ip: "10.80.0.1"}).must(201, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "G"}, &gj)
	guest := &user{client: &client{t: t, token: gj.GetTokens().GetAccessToken(), ip: "10.80.0.2"}, id: gj.GetMe().GetUser().GetId()}
	// M7: a member of another room only is invisible to the guest.
	var priv v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "p", IsPrivate: true}, &priv)
	hermit := register(t, invite(t, o, wid))
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: append(cloneOverrides(t, o, rid), &v1.RoomPermissionOverride{
		TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: hermit.id, Deny: uint64(perm.ViewRoom)})}, nil)
	var ms v1.ListMembersResponse
	guest.must(200, "GET", "/api/workspaces/"+wid+"/members", nil, &ms)
	for _, mm := range ms.GetMembers() {
		if mm.GetUser().GetId() == hermit.id {
			t.Fatal("guest sees a member who shares no room with them")
		}
	}
	for _, snap := range dialGW(t).identify(guest.token).GetWorkspaces() {
		for _, mm := range snap.GetMembers() {
			if mm.GetUser().GetId() == hermit.id {
				t.Fatal("guest READY lists a member outside their rooms")
			}
		}
	}
	// M8: guest without ATTACH_FILES cannot upload.
	if st, _, _ := upload(t, guest, "/api/workspaces/"+wid+"/files", "x.txt", []byte("x")); st != 403 {
		t.Fatalf("guest upload: %d", st)
	}
	// M12: guest → member only via promote.
	member := v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER
	o.must(422, "PATCH", "/api/workspaces/"+wid+"/members/"+guest.id, &v1.UpdateMemberRequest{Role: &member}, nil)
	// L6: guest accounts cannot use workspace invite codes.
	otherWS := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	guest.must(403, "POST", "/api/invites/"+invite(t, o, otherWS.GetId())+"/join", nil, nil)

	// L4: a link does not lift an admin's explicit deny for an existing member.
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Deny: uint64(perm.ViewRoom)},
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Deny: uint64(perm.Speak)},
	}}, nil)
	bob.must(200, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", nil, nil)
	var gr v1.GetRoomResponse
	bob.must(200, "GET", "/api/rooms/"+rid, nil, &gr)
	if perm.Bits(gr.GetPermissions()).Has(perm.Speak) {
		t.Fatal("room link lifted an explicit SPEAK deny")
	}

	// L9: a non-admin with MANAGE_ROOM can re-submit, but not drop, an admin's allow they lack.
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Allow: uint64(perm.ManageRoom)},
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "guest", Allow: uint64(perm.ViewRoom | perm.MuteMembers)},
	}}, nil)
	var cur v1.GetRoomResponse
	o.must(200, "GET", "/api/rooms/"+rid, nil, &cur)
	bob.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: cur.GetRoom().GetPermissionOverrides()}, nil)
	bob.must(403, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Allow: uint64(perm.ManageRoom)},
	}}, nil)

	// L13: a member moderator (MUTE_MEMBERS via override) cannot act on the owner.
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Allow: uint64(perm.MuteMembers | perm.MoveMembers)},
	}}, nil)
	bob.must(403, "POST", "/api/rooms/"+rid+"/voice/"+o.id+"/mute", nil, nil)
	bob.must(403, "POST", "/api/rooms/"+rid+"/voice/"+o.id+"/move", &v1.MoveMemberRequest{TargetRoomId: rid}, nil)

	// M3: inbound flood closes the socket with 4008.
	g := dialGW(t)
	g.identify(bob.token)
	for range 250 {
		g.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_HEARTBEAT, Payload: &v1.GatewayFrame_Heartbeat{Heartbeat: &v1.Heartbeat{}}})
	}
	if st := g.closeStatus(); st != websocket.StatusCode(4008) {
		t.Fatalf("inbound flood: close %d, want 4008", st)
	}
}

func cloneOverrides(t *testing.T, u *user, rid string) []*v1.RoomPermissionOverride {
	t.Helper()
	var r v1.GetRoomResponse
	u.must(200, "GET", "/api/rooms/"+rid, nil, &r)
	return r.GetRoom().GetPermissionOverrides()
}
