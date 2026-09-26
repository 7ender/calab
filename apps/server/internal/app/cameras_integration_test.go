//go:build integration

package app_test

import (
	"context"
	"os/exec"
	"slices"
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
