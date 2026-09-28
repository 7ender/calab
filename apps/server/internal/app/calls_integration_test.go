//go:build integration

package app_test

import (
	"context"
	"strings"
	"testing"
	"time"

	lkauth "github.com/livekit/protocol/auth"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/calls"
)

// One-to-one calls (ADR-0034): signalling, the DM voice session, the call log and presence.

// callTeam: three fresh people in one workspace (the shared owner only creates it, so a call
// state left by another test cannot interfere), each with a gateway connection.
type callPeer struct {
	*user
	g *gw
}

func callTeam(t *testing.T) (a, b, c callPeer, wsID string) {
	t.Helper()
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	mk := func(name string) callPeer {
		u := register(t, invite(t, o, ws.GetId()))
		rename(t, u, name+" "+uniq(""))
		g := dialGW(t)
		g.identify(u.token)
		return callPeer{user: u, g: g}
	}
	return mk("Alice"), mk("Bob"), mk("Carol"), ws.GetId()
}

func startCall(t *testing.T, u *user, dmID string) *v1.Call {
	t.Helper()
	var r v1.StartCallResponse
	u.must(201, "POST", "/api/dms/"+dmID+"/call", nil, &r)
	if r.GetCall().GetState() != v1.CallState_CALL_STATE_RINGING {
		t.Fatalf("new call: %v", r.GetCall())
	}
	return r.GetCall()
}

func callAction(t *testing.T, u *user, want int, callID, action string) *v1.Call {
	t.Helper()
	var r v1.CallActionResponse
	u.must(want, "POST", "/api/calls/"+callID+"/"+action, nil, &r)
	return r.GetCall()
}

func callStateIs(id string, st v1.CallState) func(*v1.DispatchEvent) bool {
	return func(e *v1.DispatchEvent) bool {
		c := e.GetCallState().GetCall()
		return c.GetId() == id && c.GetState() == st
	}
}

func callCard(roomID string, outcome v1.CallOutcome) func(*v1.DispatchEvent) bool {
	return func(e *v1.DispatchEvent) bool {
		m := e.GetMessageCreate().GetMessage()
		return m.GetRoomId() == roomID && m.GetSystem().GetCall().GetOutcome() == outcome
	}
}

func onCall(uid string, on bool) func(*v1.DispatchEvent) bool {
	return func(e *v1.DispatchEvent) bool {
		p := e.GetPresenceUpdate().GetPresence()
		return e.GetPresenceUpdate() != nil && p.GetUserId() == uid && p.GetOnCall() == on
	}
}

func dmUnread(t *testing.T, u *user, roomID string) uint32 {
	t.Helper()
	var l v1.ListDmsResponse
	u.must(200, "GET", "/api/dms", nil, &l)
	for _, d := range l.GetDms() {
		if d.GetRoom().GetId() == roomID {
			return d.GetReadState().GetUnreadCount()
		}
	}
	t.Fatalf("DM %s not listed", roomID)
	return 0
}

func errCode(t *testing.T, u *user, method, path string) v1.ErrorCode {
	t.Helper()
	return u.rawErr(method, path).GetCode()
}

// TestCallFullCycle: ring → accept → join → hangup, with the log card, presence, the DM voice
// session (grants, events only to the two participants) and the checks around it.
func TestCallFullCycle(t *testing.T) {
	liveKitUp(t)
	a, b, c, _ := callTeam(t)
	dm := openDM(t, a.user, b.id, 201).GetRoom().GetId()

	// No call: the DM cannot be joined (409 CALL_NOT_ACTIVE); a stranger does not see it (404).
	if code := errCode(t, a.user, "POST", "/api/rooms/"+dm+"/join"); code != v1.ErrorCode_ERROR_CODE_CALL_NOT_ACTIVE {
		t.Fatalf("join without a call: %v", code)
	}
	c.must(404, "POST", "/api/rooms/"+dm+"/join", nil, nil)
	c.must(404, "POST", "/api/dms/"+dm+"/call", nil, nil)

	call := startCall(t, a.user, dm)
	if call.GetCallerId() != a.id || call.GetCalleeId() != b.id || call.GetDmRoomId() != dm || call.GetCreatedAt() == nil {
		t.Fatalf("call: %v", call)
	}
	ring := b.g.wait("CALL_RING", func(e *v1.DispatchEvent) bool { return e.GetCallRing().GetCall().GetId() == call.GetId() })
	if ring.GetCallRing().GetCaller().GetId() != a.id || ring.GetCallRing().GetCaller().GetDisplayName() == "" {
		t.Fatalf("CALL_RING caller: %v", ring)
	}
	b.g.wait("CALL_STATE ringing (callee)", callStateIs(call.GetId(), v1.CallState_CALL_STATE_RINGING))
	a.g.wait("CALL_STATE ringing (caller)", callStateIs(call.GetId(), v1.CallState_CALL_STATE_RINGING))
	// Ringing is not active: no join yet; the stranger cannot act on the call.
	if code := errCode(t, a.user, "POST", "/api/rooms/"+dm+"/join"); code != v1.ErrorCode_ERROR_CODE_CALL_NOT_ACTIVE {
		t.Fatalf("join while ringing: %v", code)
	}
	c.must(404, "POST", "/api/calls/"+call.GetId()+"/accept", nil, nil)
	a.must(403, "POST", "/api/calls/"+call.GetId()+"/accept", nil, nil) // the caller cannot answer
	a.must(409, "POST", "/api/calls/"+call.GetId()+"/hangup", nil, nil) // nothing to hang up yet

	// Accept → ACTIVE for both; a second accept is 409; presence says «on a call».
	acc := callAction(t, b.user, 200, call.GetId(), "accept")
	if acc.GetState() != v1.CallState_CALL_STATE_ACTIVE || acc.GetAnsweredAt() == nil {
		t.Fatalf("accepted: %v", acc)
	}
	a.g.wait("CALL_STATE active (caller)", callStateIs(call.GetId(), v1.CallState_CALL_STATE_ACTIVE))
	b.g.wait("CALL_STATE active (callee)", callStateIs(call.GetId(), v1.CallState_CALL_STATE_ACTIVE))
	b.must(409, "POST", "/api/calls/"+call.GetId()+"/accept", nil, nil)
	c.g.wait("alice on a call", onCall(a.id, true))
	c.g.wait("bob on a call", onCall(b.id, true))

	// Both join the DM session: LiveKit room dm:<id>, every source granted, no workspace.
	var ja, jb v1.JoinVoiceResponse
	a.must(200, "POST", "/api/rooms/"+dm+"/join", nil, &ja)
	v, err := lkauth.ParseAPIToken(ja.GetToken())
	if err != nil {
		t.Fatal(err)
	}
	_, grants, err := v.Verify("secret")
	if err != nil {
		t.Fatal(err)
	}
	if grants.Video.Room != "dm:"+dm || !grants.Video.RoomJoin || grants.Video.RoomAdmin ||
		strings.Join(grants.Video.CanPublishSources, ",") != "microphone,screen_share,screen_share_audio,camera" {
		t.Fatalf("DM grants: %+v", grants.Video)
	}
	if !ja.GetPending() || !ja.GetCanSpeak() || !ja.GetCanVideo() || !ja.GetCanStream() || ja.GetPlanLimits() != nil {
		t.Fatalf("DM join: %v", &ja)
	}
	voiceIn := func(uid string, pending bool) func(*v1.DispatchEvent) bool {
		return func(e *v1.DispatchEvent) bool {
			s := e.GetVoiceStateUpdate().GetState()
			return e.GetVoiceStateUpdate() != nil && s.GetUserId() == uid && s.GetRoomId() == dm && s.GetPending() == pending
		}
	}
	ev := b.g.wait("alice pending in the call", voiceIn(a.id, true))
	if ev.GetVoiceStateUpdate().GetState().GetWorkspaceId() != "" {
		t.Fatalf("DM voice state carries a workspace: %v", ev)
	}
	webhook(t, whEvent("participant_joined", "dm:"+dm, ja.GetIdentity(), nil), "secret")
	b.g.wait("alice connected", voiceIn(a.id, false))
	b.must(200, "POST", "/api/rooms/"+dm+"/join", nil, &jb)
	webhook(t, whEvent("participant_joined", "dm:"+dm, jb.GetIdentity(), nil), "secret")
	a.g.wait("bob connected", voiceIn(b.id, false))
	// Stream / camera requests of a call answer at once (the grant has every source).
	a.must(200, "POST", "/api/rooms/"+dm+"/stream/request", &v1.RequestStreamRequest{}, nil)
	a.must(200, "POST", "/api/rooms/"+dm+"/camera/request", &v1.RequestCameraRequest{}, nil)
	a.must(204, "POST", "/api/rooms/"+dm+"/camera/stop", nil, nil)
	// A third member of the workspace sees nothing of the call's voice.
	c.g.quiet("the call's voice state", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetVoiceStateUpdate().GetState().GetRoomId() == dm
	})

	// Hang up → ENDED for both, the log card (read by both), presence back, session closed.
	time.Sleep(1100 * time.Millisecond) // a non-zero duration
	end := callAction(t, b.user, 200, call.GetId(), "hangup")
	if end.GetState() != v1.CallState_CALL_STATE_ENDED || end.GetReason() != "hangup" || end.GetEndedAt() == nil {
		t.Fatalf("ended: %v", end)
	}
	a.g.wait("CALL_STATE ended", callStateIs(call.GetId(), v1.CallState_CALL_STATE_ENDED))
	for _, p := range []callPeer{a, b} {
		m := p.g.wait("ENDED card", callCard(dm, v1.CallOutcome_CALL_OUTCOME_ENDED)).GetMessageCreate().GetMessage()
		card := m.GetSystem().GetCall()
		if m.GetAuthorId() != a.id || m.GetKind() != v1.MessageKind_MESSAGE_KIND_SYSTEM || card.GetCallerId() != a.id ||
			card.GetDurationSec() < 1 || card.GetCallId() != call.GetId() || card.GetStartedAt() == nil {
			t.Fatalf("card: %v", m)
		}
	}
	a.g.wait("alice out of the session", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return e.GetVoiceStateUpdate() != nil && s.GetUserId() == a.id && s.GetRoomId() == ""
	})
	c.g.wait("alice off the call", onCall(a.id, false))
	c.g.wait("bob off the call", onCall(b.id, false))
	b.must(409, "POST", "/api/calls/"+call.GetId()+"/hangup", nil, nil)
	if code := errCode(t, a.user, "POST", "/api/rooms/"+dm+"/join"); code != v1.ErrorCode_ERROR_CODE_CALL_NOT_ACTIVE {
		t.Fatalf("join after the end: %v", code)
	}
	if n := dmUnread(t, b.user, dm); n != 0 {
		t.Fatalf("an answered call's card is unread for the callee: %d", n)
	}
	// History has the card.
	var list v1.ListMessagesResponse
	b.must(200, "GET", "/api/rooms/"+dm+"/messages", nil, &list)
	if len(list.GetMessages()) != 1 || list.GetMessages()[0].GetSystem().GetCall().GetOutcome() != v1.CallOutcome_CALL_OUTCOME_ENDED {
		t.Fatalf("history: %v", &list)
	}
	// A new call works right away (indexes were cleared).
	again := startCall(t, b.user, dm)
	callAction(t, b.user, 200, again.GetId(), "cancel")
}

// TestCallDeclineCancelBusy: decline and cancel by the right side only, BUSY and IN_CALL.
func TestCallDeclineCancelBusy(t *testing.T) {
	a, b, c, _ := callTeam(t)
	ab := openDM(t, a.user, b.id, 201).GetRoom().GetId()
	cb := openDM(t, c.user, b.id, 201).GetRoom().GetId()
	ac := openDM(t, a.user, c.id, 201).GetRoom().GetId()

	// Decline: only the callee. Bob has an unread message from alice: the card must not mark
	// it read (it counts as unread next to it).
	send(t, a.user, ab, "ты тут?", uniq("n"))
	call := startCall(t, a.user, ab)
	a.must(403, "POST", "/api/calls/"+call.GetId()+"/decline", nil, nil)
	b.must(403, "POST", "/api/calls/"+call.GetId()+"/cancel", nil, nil)
	if d := callAction(t, b.user, 200, call.GetId(), "decline"); d.GetState() != v1.CallState_CALL_STATE_DECLINED {
		t.Fatalf("declined: %v", d)
	}
	a.g.wait("CALL_STATE declined", callStateIs(call.GetId(), v1.CallState_CALL_STATE_DECLINED))
	a.g.wait("DECLINED card", callCard(ab, v1.CallOutcome_CALL_OUTCOME_DECLINED))
	b.must(409, "POST", "/api/calls/"+call.GetId()+"/accept", nil, nil)
	if n := dmUnread(t, b.user, ab); n != 2 {
		t.Fatalf("unread after a declined call over an unread message: %d, want 2", n)
	}

	// Busy: bob is being called by alice; carol's call gets 409 BUSY and a BUSY card in the
	// carol–bob DM (no ringing for bob); alice cannot place a second call (IN_CALL).
	call = startCall(t, a.user, ab)
	if code := errCode(t, c.user, "POST", "/api/dms/"+cb+"/call"); code != v1.ErrorCode_ERROR_CODE_BUSY {
		t.Fatalf("calling a busy user: %v", code)
	}
	m := b.g.wait("BUSY card (callee)", callCard(cb, v1.CallOutcome_CALL_OUTCOME_BUSY)).GetMessageCreate().GetMessage()
	if m.GetAuthorId() != c.id || m.GetSystem().GetCall().GetCallId() != "" {
		t.Fatalf("BUSY card: %v", m)
	}
	c.g.wait("BUSY card (caller)", callCard(cb, v1.CallOutcome_CALL_OUTCOME_BUSY))
	if code := errCode(t, a.user, "POST", "/api/dms/"+ac+"/call"); code != v1.ErrorCode_ERROR_CODE_IN_CALL {
		t.Fatalf("second call of the caller: %v", code)
	}
	if code := errCode(t, c.user, "POST", "/api/dms/"+ac+"/call"); code != v1.ErrorCode_ERROR_CODE_BUSY {
		t.Fatalf("calling a user who is calling: %v", code)
	}
	if n := dmUnread(t, b.user, cb); n != 0 {
		t.Fatalf("a BUSY card is unread for the callee: %d", n)
	}

	// Cancel: only the caller; then both are free again.
	if cc := callAction(t, a.user, 200, call.GetId(), "cancel"); cc.GetState() != v1.CallState_CALL_STATE_CANCELLED {
		t.Fatalf("cancelled: %v", cc)
	}
	b.g.wait("CALL_STATE cancelled", callStateIs(call.GetId(), v1.CallState_CALL_STATE_CANCELLED))
	b.g.wait("CANCELLED card", callCard(ab, v1.CallOutcome_CALL_OUTCOME_CANCELLED))
	a.must(409, "POST", "/api/calls/"+call.GetId()+"/cancel", nil, nil)
	next := startCall(t, c.user, cb)
	callAction(t, c.user, 200, next.GetId(), "cancel")
}

// callTimers sets the call timeouts for one test and pauses the periodic sweep (it fires every
// 15 s and would race the path under test: a MISSED / lost end must come from exactly one
// source); instanceTimers false leaves only an explicit Sweep. Restored on cleanup.
func callTimers(t *testing.T, ring, lost time.Duration, instanceTimers bool) {
	t.Helper()
	testApp.Calls.SetPeriodicSweep(false)
	testApp.Calls.SetInstanceTimers(instanceTimers)
	testApp.Calls.SetTimeouts(ring, lost, calls.DefaultTick)
	t.Cleanup(func() {
		testApp.Calls.SetTimeouts(calls.DefaultRingTimeout, calls.DefaultLostGrace, calls.DefaultTick)
		testApp.Calls.SetInstanceTimers(true)
		testApp.Calls.SetPeriodicSweep(true)
	})
}

// TestCallMissed: no answer → MISSED by the instance timer, and by the sweeper when that
// timer is gone; the card is unread for the callee only.
func TestCallMissed(t *testing.T) {
	a, b, _, _ := callTeam(t)
	dm := openDM(t, a.user, b.id, 201).GetRoom().GetId()

	t.Run("timer", func(t *testing.T) {
		callTimers(t, time.Second, calls.DefaultLostGrace, true)
		call := startCall(t, a.user, dm)
		started := time.Now()
		b.g.wait("CALL_STATE missed", callStateIs(call.GetId(), v1.CallState_CALL_STATE_MISSED))
		if el := time.Since(started); el < 900*time.Millisecond {
			t.Fatalf("missed after %v", el)
		}
		a.g.wait("MISSED card", callCard(dm, v1.CallOutcome_CALL_OUTCOME_MISSED))
		b.must(409, "POST", "/api/calls/"+call.GetId()+"/accept", nil, nil)
		if n := dmUnread(t, b.user, dm); n != 1 {
			t.Fatalf("missed call unread for the callee: %d", n)
		}
		if n := dmUnread(t, a.user, dm); n != 0 {
			t.Fatalf("missed call unread for the caller: %d", n)
		}
	})

	// The instance that placed the call is gone (no timer): only a sweep settles it.
	t.Run("sweeper", func(t *testing.T) {
		callTimers(t, time.Second, calls.DefaultLostGrace, false)
		call := startCall(t, a.user, dm)
		time.Sleep(1200 * time.Millisecond)
		b.g.quiet("MISSED without a sweep", 100*time.Millisecond, callStateIs(call.GetId(), v1.CallState_CALL_STATE_MISSED))
		testApp.Calls.Sweep(context.Background())
		b.g.wait("CALL_STATE missed (sweeper)", callStateIs(call.GetId(), v1.CallState_CALL_STATE_MISSED))
	})
}

// TestCallLost: an ACTIVE call whose participant left the session (or never joined) and did
// not come back within the grace ends with reason "lost".
func TestCallLost(t *testing.T) {
	liveKitUp(t)
	a, b, _, _ := callTeam(t)
	dm := openDM(t, a.user, b.id, 201).GetRoom().GetId()
	callTimers(t, calls.DefaultRingTimeout, time.Second, true)

	call := startCall(t, a.user, dm)
	callAction(t, b.user, 200, call.GetId(), "accept")
	var ja, jb v1.JoinVoiceResponse
	a.must(200, "POST", "/api/rooms/"+dm+"/join", nil, &ja)
	b.must(200, "POST", "/api/rooms/"+dm+"/join", nil, &jb)
	webhook(t, whEvent("participant_joined", "dm:"+dm, ja.GetIdentity(), nil), "secret")
	webhook(t, whEvent("participant_joined", "dm:"+dm, jb.GetIdentity(), nil), "secret")
	// Both are in: the grace passes without an end.
	a.g.quiet("an end while both are in", 1500*time.Millisecond, callStateIs(call.GetId(), v1.CallState_CALL_STATE_ENDED))
	// Bob drops out and does not come back.
	webhook(t, whEvent("participant_left", "dm:"+dm, jb.GetIdentity(), nil), "secret")
	ev := a.g.wait("CALL_STATE ended (lost)", callStateIs(call.GetId(), v1.CallState_CALL_STATE_ENDED))
	if ev.GetCallState().GetCall().GetReason() != "lost" {
		t.Fatalf("lost call: %v", ev)
	}
	b.g.wait("ENDED card", callCard(dm, v1.CallOutcome_CALL_OUTCOME_ENDED))

	// Answered, but nobody ever joins: lost as well.
	call = startCall(t, b.user, dm)
	callAction(t, a.user, 200, call.GetId(), "accept")
	ev = b.g.wait("CALL_STATE ended (never joined)", callStateIs(call.GetId(), v1.CallState_CALL_STATE_ENDED))
	if ev.GetCallState().GetCall().GetReason() != "lost" {
		t.Fatalf("never joined: %v", ev)
	}
}

// TestCallResume: a device that was offline gets the ringing call on RESUME (replayed
// CALL_RING) and in READY.call after a new IDENTIFY; READY.call follows the state.
func TestCallResume(t *testing.T) {
	a, b, _, _ := callTeam(t)
	dm := openDM(t, a.user, b.id, 201).GetRoom().GetId()
	g := dialGW(t)
	ready := g.identify(b.token)
	if ready.GetCall() != nil {
		t.Fatalf("READY.call without a call: %v", ready.GetCall())
	}
	last := g.last
	_ = g.ws.CloseNow()
	time.Sleep(100 * time.Millisecond)

	call := startCall(t, a.user, dm)
	g2 := dialGW(t)
	g2.last = last
	g2.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_RESUME, Payload: &v1.GatewayFrame_Resume{Resume: &v1.Resume{
		Token: b.token, SessionId: ready.GetSessionId(), Seq: last}}})
	g2.wait("CALL_RING replayed", func(e *v1.DispatchEvent) bool { return e.GetCallRing().GetCall().GetId() == call.GetId() })

	if rc := dialGW(t).identify(b.token).GetCall(); rc.GetId() != call.GetId() || rc.GetState() != v1.CallState_CALL_STATE_RINGING {
		t.Fatalf("READY.call ringing (callee): %v", rc)
	}
	if rc := dialGW(t).identify(a.token).GetCall(); rc.GetId() != call.GetId() {
		t.Fatalf("READY.call ringing (caller): %v", rc)
	}
	callAction(t, b.user, 200, call.GetId(), "accept")
	if rc := dialGW(t).identify(a.token).GetCall(); rc.GetState() != v1.CallState_CALL_STATE_ACTIVE {
		t.Fatalf("READY.call active: %v", rc)
	}
	callAction(t, a.user, 200, call.GetId(), "hangup")
	if rc := dialGW(t).identify(b.token).GetCall(); rc != nil {
		t.Fatalf("READY.call after the end: %v", rc)
	}
}

// TestCallRingSpam: cancelling and calling the same person again is bounded per DM (3 at
// once, then one per 30 s: 429), well below the overall per-user limit, so other DMs still
// ring and the callee can still call back.
func TestCallRingSpam(t *testing.T) {
	a, b, c, _ := callTeam(t)
	ab := openDM(t, a.user, b.id, 201).GetRoom().GetId()
	ac := openDM(t, a.user, c.id, 201).GetRoom().GetId()
	for range 3 {
		callAction(t, a.user, 200, startCall(t, a.user, ab).GetId(), "cancel")
	}
	a.must(429, "POST", "/api/dms/"+ab+"/call", nil, nil)
	callAction(t, a.user, 200, startCall(t, a.user, ac).GetId(), "cancel")
	callAction(t, b.user, 200, startCall(t, b.user, ab).GetId(), "cancel")
}

// TestCallBots: bots neither call nor answer, and cannot be called.
func TestCallBots(t *testing.T) {
	a, _, _, wsID := callTeam(t)
	bt := createBot(t, owner(t), wsID, "caller")
	var d v1.CreateDmResponse
	bt.must(201, "POST", "/api/dms", &v1.CreateDmRequest{UserId: a.id}, &d)
	dm := d.GetDm().GetRoom().GetId()
	if st := bt.do("POST", "/api/dms/"+dm+"/call", nil, nil); st != 403 {
		t.Fatalf("a bot calls: %d", st)
	}
	if reason, _ := errReason(bt.client); reason != "BOT_NOT_ALLOWED" {
		t.Fatalf("bot call refusal: %q", reason)
	}
	a.must(403, "POST", "/api/dms/"+dm+"/call", nil, nil) // calling a bot
	if st := bt.do("POST", "/api/rooms/"+dm+"/join", nil, nil); st != 403 {
		t.Fatalf("a bot joins a DM session: %d", st)
	}
}
