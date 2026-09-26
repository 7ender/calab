//go:build integration

package app_test

import (
	"context"
	"fmt"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/rtc"
)

// publishDemoCamera joins the dev LiveKit room as identity with the lk CLI and publishes
// its demo video, which LiveKit reports as a CAMERA track. Returns the track sid.
func publishDemoCamera(t *testing.T, room, identity string) string {
	t.Helper()
	lk, err := exec.LookPath("lk")
	if err != nil {
		t.Skip("lk CLI not installed (brew install livekit-cli): needed to publish a real camera track")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, lk, "room", "join", //nolint:gosec // G204: test helper, lk from PATH, fixed args "--url", testCfg.LiveKitInternalURL,
		"--api-key", testCfg.LiveKitAPIKey, "--api-secret", testCfg.LiveKitAPISecret,
		"--identity", identity, "--publish-demo", room)
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); _ = cmd.Wait() })
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if p, err := lkRec.GetParticipant(context.Background(), room, identity); err == nil {
			for _, tr := range p.Tracks {
				if tr.Source == rtc.SourceCamera {
					return tr.Sid
				}
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("demo camera track did not appear in LiveKit")
	return ""
}

func hasSource(p rtc.Permission, src rtc.TrackSource) bool {
	return slices.Contains(p.CanPublishSources, src)
}

func TestCameras(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	roomName := "ws_" + ws.GetId() + "_room_" + rid
	limit := func(n uint32) {
		o.must(200, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{MediaOverride: &v1.RoomMediaOverride{CameraLimit: &n}}, nil)
	}
	// Workspace default (6 unless changed), validated 0..25; a room without override follows it.
	var got v1.GetRoomResponse
	o.must(200, "GET", "/api/rooms/"+rid, nil, &got)
	if got.GetRoom().GetMedia().GetCameraLimit() != 6 {
		t.Fatalf("default camera_limit %d, want 6", got.GetRoom().GetMedia().GetCameraLimit())
	}
	bad, four := uint32(30), uint32(4)
	o.must(422, "PATCH", "/api/workspaces/"+ws.GetId(), &v1.UpdateWorkspaceRequest{DefaultCameraLimit: &bad}, nil)
	o.must(200, "PATCH", "/api/workspaces/"+ws.GetId(), &v1.UpdateWorkspaceRequest{DefaultCameraLimit: &four}, nil)
	o.must(200, "GET", "/api/rooms/"+rid, nil, &got)
	if got.GetRoom().GetMedia().GetCameraLimit() != 4 {
		t.Fatalf("camera_limit %d after workspace default 4", got.GetRoom().GetMedia().GetCameraLimit())
	}
	o.must(422, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{MediaOverride: &v1.RoomMediaOverride{CameraLimit: &bad}}, nil)
	limit(1)
	g := dialGW(t)
	g.identify(o.token)

	var bj v1.JoinVoiceResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &bj)
	if !bj.GetCanVideo() || bj.GetMedia().GetCameraLimit() != 1 {
		t.Fatalf("join: can_video %v, camera_limit %d", bj.GetCanVideo(), bj.GetMedia().GetCameraLimit())
	}
	webhook(t, whEvent("participant_joined", roomName, bj.GetIdentity(), nil), "secret")
	g.wait("bob in voice", func(e *v1.DispatchEvent) bool { return e.GetVoiceStateUpdate().GetState().GetRoomId() == rid })
	bob.must(409, "POST", "/api/rooms/"+rid+"/camera/request", nil, nil) // not connected to LiveKit yet

	// A real participant with a real camera track in the dev LiveKit.
	sid := publishDemoCamera(t, roomName, bj.GetIdentity())
	bob.must(204, "POST", "/api/rooms/"+rid+"/camera/request", nil, nil)
	if p, _ := lkRec.lastPerm(bj.GetIdentity()); !hasSource(p, rtc.SourceCamera) {
		t.Fatalf("camera source not granted: %+v", p)
	}
	webhook(t, whEvent("track_published", roomName, bj.GetIdentity(), &livekit.TrackInfo{Sid: sid, Source: livekit.TrackSource_CAMERA, Type: livekit.TrackType_VIDEO}), "secret")
	g.wait("VOICE_STATE_UPDATE camera on", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == bob.id && s.GetCamera()
	})
	found := false
	for _, s := range dialGW(t).identify(bob.token).GetWorkspaces() {
		for _, vs := range s.GetVoiceStates() {
			found = found || (vs.GetUserId() == bob.id && vs.GetCamera())
		}
	}
	if !found {
		t.Fatal("READY lacks camera")
	}

	// camera_limit = 1: the owner's request is refused; a camera published anyway is muted.
	var oj v1.JoinVoiceResponse
	o.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &oj)
	webhook(t, whEvent("participant_joined", roomName, oj.GetIdentity(), nil), "secret")
	g.wait("owner in voice", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == o.id && s.GetRoomId() == rid
	})
	webhook(t, whEvent("track_published", roomName, oj.GetIdentity(), &livekit.TrackInfo{Sid: "TR_o_cam", Source: livekit.TrackSource_CAMERA, Type: livekit.TrackType_VIDEO}), "secret")
	g.wait("VOICE_CAMERA_STOP limit", func(e *v1.DispatchEvent) bool {
		c := e.GetVoiceCameraStop()
		return c.GetTrackSid() == "TR_o_cam" && c.GetReason() == v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_LIMIT_REACHED
	})
	if !slices.Contains(lkRec.mutedTracks(), oj.GetIdentity()+"/TR_o_cam") {
		t.Fatal("over-limit camera not muted")
	}

	// Moderator stop: the real track is muted in LiveKit, the grant loses the camera.
	bob.must(403, "POST", "/api/rooms/"+rid+"/voice/"+o.id+"/stop-camera", nil, nil)
	o.must(204, "POST", "/api/rooms/"+rid+"/voice/"+bob.id+"/stop-camera", nil, nil)
	g.wait("VOICE_CAMERA_STOP moderator", func(e *v1.DispatchEvent) bool {
		c := e.GetVoiceCameraStop()
		return c.GetTrackSid() == sid && c.GetReason() == v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_MODERATOR
	})
	g.wait("VOICE_STATE_UPDATE camera off", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == bob.id && !s.GetCamera() && s.GetRoomId() == rid
	})
	if p, _ := lkRec.lastPerm(bj.GetIdentity()); hasSource(p, rtc.SourceCamera) {
		t.Fatalf("camera still granted after moderator stop: %+v", p)
	}
	// In LiveKit the track ends up muted, or unpublished altogether once the grant no longer
	// allows the camera source (what the dev server does).
	deadline := time.Now().Add(5 * time.Second)
	for off := false; !off; {
		if time.Now().After(deadline) {
			p, err := lkRec.GetParticipant(context.Background(), roomName, bj.GetIdentity())
			t.Fatalf("camera still live in LiveKit: %+v %v", p, err)
		}
		if p, err := lkRec.GetParticipant(context.Background(), roomName, bj.GetIdentity()); err == nil {
			off = true
			for _, tr := range p.Tracks {
				if tr.Sid == sid && !tr.Muted {
					off = false
				}
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !slices.Contains(lkRec.mutedTracks(), bj.GetIdentity()+"/"+sid) {
		t.Fatal("moderator stop did not mute the track")
	}
	o.must(404, "POST", "/api/rooms/"+rid+"/voice/"+bob.id+"/stop-camera", nil, nil)

	// The moderator's stop is sticky: a new request needs allow-camera first.
	bob.must(403, "POST", "/api/rooms/"+rid+"/camera/request", nil, nil)
	o.must(204, "POST", "/api/rooms/"+rid+"/voice/"+bob.id+"/allow-camera", nil, nil)

	// Own stop releases the grant; cameras off (0) and a VIDEO deny refuse requests.
	bob.must(204, "POST", "/api/rooms/"+rid+"/camera/request", nil, nil)
	bob.must(204, "POST", "/api/rooms/"+rid+"/camera/stop", nil, nil)
	if p, _ := lkRec.lastPerm(bj.GetIdentity()); hasSource(p, rtc.SourceCamera) {
		t.Fatalf("camera still granted after own stop: %+v", p)
	}
	limit(0)
	bob.must(409, "POST", "/api/rooms/"+rid+"/camera/request", nil, nil)
	limit(6)
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Deny: 1 << 14},
	}}, nil)
	bob.must(403, "POST", "/api/rooms/"+rid+"/camera/request", nil, nil)
	bob.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &bj)
	if bj.GetCanVideo() {
		t.Fatal("can_video without VIDEO")
	}
}

// joinVoice joins a device to a voice room and delivers participant_joined; returns its identity.
func joinCall(t *testing.T, u *user, g *gw, rid, roomName string) string {
	t.Helper()
	var j v1.JoinVoiceResponse
	u.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &j)
	webhook(t, whEvent("participant_joined", roomName, j.GetIdentity(), nil), "secret")
	g.wait("in voice", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == u.id && s.GetRoomId() == rid
	})
	return j.GetIdentity()
}

func cameraPublished(t *testing.T, roomName, identity, sid string) {
	t.Helper()
	webhook(t, whEvent("track_published", roomName, identity, &livekit.TrackInfo{Sid: sid, Source: livekit.TrackSource_CAMERA, Type: livekit.TrackType_VIDEO}), "secret")
}

func reconcileNow(t *testing.T) {
	t.Helper()
	_ = testRedis.Do(context.Background(), testRedis.B().Del().Key("rtc:reconcile").Build()).Error()
	if err := testApp.RTC.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func cameraRecords(t *testing.T, rid string) map[string]string {
	t.Helper()
	m, err := testRedis.Do(context.Background(), testRedis.B().Hgetall().Key("voice:cameras:"+rid).Build()).AsStrMap()
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func newVoiceRoom(t *testing.T, o *user, wid, name string, cameraLimit uint32) string {
	t.Helper()
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: name,
		MediaOverride: &v1.RoomMediaOverride{CameraLimit: &cameraLimit}}, &cr)
	return cr.GetRoom().GetId()
}

// Two cameras published at the same moment against camera_limit 1: the Lua check lets
// exactly one through.
func TestCamerasConcurrentLimit(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, _ := setupTeam(t)
	rid := newVoiceRoom(t, o, ws.GetId(), "one-cam", 1)
	roomName := "ws_" + ws.GetId() + "_room_" + rid
	g := dialGW(t)
	g.identify(o.token)
	bi := joinCall(t, bob, g, rid, roomName)
	oi := joinCall(t, o, g, rid, roomName)
	done := make(chan struct{}, 2)
	for _, p := range [][2]string{{bi, "TR_cam_b"}, {oi, "TR_cam_o"}} {
		go func() { cameraPublished(t, roomName, p[0], p[1]); done <- struct{}{} }()
	}
	<-done
	<-done
	g.wait("one LIMIT_REACHED", func(e *v1.DispatchEvent) bool {
		return e.GetVoiceCameraStop().GetReason() == v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_LIMIT_REACHED
	})
	if recs := cameraRecords(t, rid); len(recs) != 1 {
		t.Fatalf("recorded cameras %v, want exactly one", recs)
	}
}

// Webhook path, reconcile, sticky moderator stop, reservation-only stop, grant kept across
// resync / stream stop, cleanup on leave.
func TestCameraLifecycle(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, _ := setupTeam(t)
	rid := newVoiceRoom(t, o, ws.GetId(), "cams", 6)
	roomName := "ws_" + ws.GetId() + "_room_" + rid
	g := dialGW(t)
	g.identify(o.token)
	bi := joinCall(t, bob, g, rid, roomName)
	sid := publishDemoCamera(t, roomName, bi)
	camOn := func(want bool) {
		t.Helper()
		g.wait("camera flag", func(e *v1.DispatchEvent) bool {
			s := e.GetVoiceStateUpdate().GetState()
			return s.GetUserId() == bob.id && s.GetCamera() == want && s.GetRoomId() == rid
		})
	}
	granted := func() bool { p, _ := lkRec.lastPerm(bi); return hasSource(p, rtc.SourceCamera) }

	// Reconcile records a live camera whose webhook was missed.
	bob.must(204, "POST", "/api/rooms/"+rid+"/camera/request", nil, nil)
	reconcileNow(t)
	camOn(true)
	if _, ok := cameraRecords(t, rid)[sid]; !ok {
		t.Fatal("reconcile did not record the live camera")
	}
	// Reconcile spares a young record without a track, drops an old one.
	uid := strings.SplitN(bi, ":", 2)[0]
	put := func(track string, started int64) {
		v := fmt.Sprintf(`{"i":%q,"u":%q,"s":%d}`, bi, uid, started)
		if err := testRedis.Do(context.Background(), testRedis.B().Hset().Key("voice:cameras:"+rid).FieldValue().FieldValue(track, v).Build()).Error(); err != nil {
			t.Fatal(err)
		}
	}
	put("TR_ghost_young", time.Now().UnixMilli())
	put("TR_ghost_old", time.Now().Add(-time.Minute).UnixMilli())
	reconcileNow(t)
	recs := cameraRecords(t, rid)
	if _, ok := recs["TR_ghost_young"]; !ok {
		t.Fatal("young record dropped by reconcile")
	}
	if _, ok := recs["TR_ghost_old"]; ok {
		t.Fatal("old record without a track kept")
	}
	_ = testRedis.Do(context.Background(), testRedis.B().Hdel().Key("voice:cameras:"+rid).Field("TR_ghost_young").Build()).Error()

	// The camera grant survives a resync (permission change) and a stream stop.
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Allow: 1 << 1},
	}}, nil)
	time.Sleep(300 * time.Millisecond) // resync runs asynchronously
	if !granted() {
		t.Fatal("camera grant lost on resync")
	}
	bob.must(200, "POST", "/api/rooms/"+rid+"/stream/request", &v1.RequestStreamRequest{}, nil)
	o.must(404, "POST", "/api/rooms/"+rid+"/voice/"+bob.id+"/stop-stream", nil, nil) // no stream: grant pushed anyway
	if !granted() {
		t.Fatal("camera grant lost on stream stop")
	}

	// Moderator stop is sticky until allow-camera.
	o.must(204, "POST", "/api/rooms/"+rid+"/voice/"+bob.id+"/stop-camera", nil, nil)
	camOn(false)
	bob.must(403, "POST", "/api/rooms/"+rid+"/camera/request", nil, nil)
	if granted() {
		t.Fatal("camera granted after stop-camera")
	}
	o.must(204, "POST", "/api/rooms/"+rid+"/voice/"+bob.id+"/allow-camera", nil, nil)
	bob.must(204, "POST", "/api/rooms/"+rid+"/camera/request", nil, nil)
	// Only a reservation (no track yet): stop-camera still acts → 204 (L8).
	o.must(204, "POST", "/api/rooms/"+rid+"/voice/"+bob.id+"/stop-camera", nil, nil)
	o.must(404, "POST", "/api/rooms/"+rid+"/voice/"+bob.id+"/stop-camera", nil, nil)

	// Leaving clears records, reservation and the sticky stop.
	webhook(t, whEvent("participant_left", roomName, bi, nil), "secret")
	g.wait("bob left", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == bob.id && s.GetRoomId() == ""
	})
	if len(cameraRecords(t, rid)) != 0 {
		t.Fatal("camera records left after participant_left")
	}
	for _, k := range []string{"voice:camreq:" + bi, "voice:camoff:" + bi} {
		if n, _ := testRedis.Do(context.Background(), testRedis.B().Exists().Key(k).Build()).AsInt64(); n != 0 {
			t.Fatalf("%s left after participant_left", k)
		}
	}
}

// Moves carry a camera into a room that allows it and stop it (ROOM_POLICY) otherwise.
func TestCameraMove(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, _ := setupTeam(t)
	a := newVoiceRoom(t, o, ws.GetId(), "a", 6)
	c := newVoiceRoom(t, o, ws.GetId(), "c", 6)
	off := newVoiceRoom(t, o, ws.GetId(), "no-cams", 0)
	name := func(rid string) string { return "ws_" + ws.GetId() + "_room_" + rid }
	g := dialGW(t)
	g.identify(o.token)
	bi := joinCall(t, bob, g, a, name(a))
	sid := publishDemoCamera(t, name(a), bi)
	bob.must(204, "POST", "/api/rooms/"+a+"/camera/request", nil, nil)
	cameraPublished(t, name(a), bi, sid)
	g.wait("camera on in a", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == bob.id && s.GetCamera() && s.GetRoomId() == a
	})

	// The open-source LiveKit answers MoveParticipant with "not implemented" (a LiveKit Cloud
	// feature): the SFU side of the move is faked here, as in TestMoveMember; everything the
	// server does around it (records, grants, events) is real.
	lkRec.mu.Lock()
	lkRec.fakeMove = true
	lkRec.mu.Unlock()
	testApp.RTC.SetSFUMove(true) // fakeMove stands for a LiveKit with MoveParticipant
	t.Cleanup(func() { lkRec.mu.Lock(); lkRec.fakeMove = false; lkRec.mu.Unlock() })
	o.must(204, "POST", "/api/rooms/"+a+"/voice/"+bob.id+"/move", &v1.MoveMemberRequest{TargetRoomId: c}, nil)
	g.wait("moved to c with the camera", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == bob.id && s.GetRoomId() == c && s.GetCamera()
	})
	if _, ok := cameraRecords(t, c)[sid]; !ok || len(cameraRecords(t, a)) != 0 {
		t.Fatal("camera record not carried to the target room")
	}
	if p, _ := lkRec.lastPerm(bi); !hasSource(p, rtc.SourceCamera) {
		t.Fatalf("camera grant lost on move: %+v", p)
	}

	o.must(204, "POST", "/api/rooms/"+c+"/voice/"+bob.id+"/move", &v1.MoveMemberRequest{TargetRoomId: off}, nil)
	g.wait("VOICE_CAMERA_STOP room policy", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceCameraStop()
		return s.GetTrackSid() == sid && s.GetRoomId() == off && s.GetReason() == v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_ROOM_POLICY
	})
	g.wait("camera off after the move", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == bob.id && s.GetRoomId() == off && !s.GetCamera()
	})
	if len(cameraRecords(t, off)) != 0 || len(cameraRecords(t, c)) != 0 {
		t.Fatal("camera records left after a policy stop")
	}
	if p, _ := lkRec.lastPerm(bi); hasSource(p, rtc.SourceCamera) {
		t.Fatalf("camera still granted in a room with cameras off: %+v", p)
	}
}

// App-level move (open-source LiveKit, ADR-0019) with a webcam on: the device comes back on
// a new connection without a camera — records and reservation gone, camera=false, no
// VOICE_CAMERA_STOP — and a moderator's sticky stop survives its old connection leaving.
func TestCameraAppLevelMove(t *testing.T) {
	liveKitUp(t)
	testApp.RTC.SetSFUMove(false)
	t.Cleanup(func() { testApp.RTC.SetSFUMove(true) })
	o, bob, ws, _ := setupTeam(t)
	a := newVoiceRoom(t, o, ws.GetId(), "a", 6)
	b := newVoiceRoom(t, o, ws.GetId(), "b", 6)
	name := func(rid string) string { return "ws_" + ws.GetId() + "_room_" + rid }
	g := dialGW(t)
	g.identify(o.token)
	bg := dialGW(t)
	bg.identify(bob.token)
	bi := joinCall(t, bob, g, a, name(a))
	sid := publishDemoCamera(t, name(a), bi)
	bob.must(204, "POST", "/api/rooms/"+a+"/camera/request", nil, nil)
	cameraPublished(t, name(a), bi, sid)
	g.wait("camera on in a", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == bob.id && s.GetCamera() && s.GetRoomId() == a
	})

	o.must(204, "POST", "/api/rooms/"+a+"/voice/"+bob.id+"/move", &v1.MoveMemberRequest{TargetRoomId: b}, nil)
	mv := bg.wait("VOICE_MOVED with a token", func(e *v1.DispatchEvent) bool { return e.GetVoiceMoved().GetToken() != "" }).GetVoiceMoved()
	// One state update: target room, camera off; no camera stop on the way.
	g.wait("in b without a camera", func(e *v1.DispatchEvent) bool {
		if c := e.GetVoiceCameraStop(); c != nil {
			t.Fatalf("VOICE_CAMERA_STOP on an app-level move: %v", c)
		}
		s := e.GetVoiceStateUpdate().GetState()
		if s.GetUserId() == bob.id && s.GetRoomId() == b && s.GetCamera() {
			t.Fatal("camera announced on in the target room")
		}
		return s.GetUserId() == bob.id && s.GetRoomId() == b && !s.GetCamera()
	})
	if len(cameraRecords(t, a)) != 0 || len(cameraRecords(t, b)) != 0 {
		t.Fatal("camera records left after an app-level move")
	}
	if n, _ := testRedis.Do(context.Background(), testRedis.B().Exists().Key("voice:camreq:"+bi).Build()).AsInt64(); n != 0 {
		t.Fatal("camera reservation left after an app-level move")
	}

	// A moderator's stop in the target survives the old connection leaving room a.
	signalJoin(t, mv.GetToken()) // the device reconnects to b with the move token
	webhook(t, whEvent("participant_joined", name(b), bi, nil), "secret")
	bob.must(204, "POST", "/api/rooms/"+b+"/camera/request", nil, nil)
	o.must(204, "POST", "/api/rooms/"+b+"/voice/"+bob.id+"/stop-camera", nil, nil)
	webhook(t, whEvent("participant_left", name(a), bi, nil), "secret")
	bob.must(403, "POST", "/api/rooms/"+b+"/camera/request", nil, nil)
}
