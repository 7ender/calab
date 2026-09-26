//go:build integration

package app_test

import (
	"context"
	"net/url"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/rtc"
)

// lkJoin connects identity to a dev LiveKit room with the lk CLI (a real participant) and
// waits until LiveKit lists it.
func lkJoin(t *testing.T, room, identity string) {
	t.Helper()
	lk, err := exec.LookPath("lk")
	if err != nil {
		t.Skip("lk CLI not installed (brew install livekit-cli): needed for a real participant")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, lk, "room", "join", "--url", testCfg.LiveKitInternalURL, //nolint:gosec // G204: test helper, lk from PATH, fixed args
		"--api-key", testCfg.LiveKitAPIKey, "--api-secret", testCfg.LiveKitAPISecret, "--identity", identity, room)
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); _ = cmd.Wait() })
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		if _, err := lkRec.GetParticipant(context.Background(), room, identity); err == nil {
			return
		}
	}
	t.Fatal("lk participant did not appear")
}

// signalJoin connects to LiveKit's signal endpoint with a token (what livekit-client does)
// and returns the JoinResponse: proof that the token is valid for that room and identity.
// The socket stays open until the test ends, so the participant stays in the room.
func signalJoin(t *testing.T, token string) *livekit.JoinResponse {
	t.Helper()
	u := "ws" + strings.TrimPrefix(testCfg.LiveKitInternalURL, "http") + "/rtc?" + url.Values{
		"access_token": {token}, "auto_subscribe": {"1"}, "sdk": {"go"}, "version": {"2.0.0"}, "protocol": {"15"},
	}.Encode()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, resp, err := websocket.Dial(ctx, u, nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("signal connect with the move token: %v", err)
	}
	t.Cleanup(func() { _ = ws.CloseNow() })
	for {
		_, b, err := ws.Read(ctx)
		if err != nil {
			t.Fatalf("signal read: %v", err)
		}
		var sr livekit.SignalResponse
		if err := proto.Unmarshal(b, &sr); err != nil {
			t.Fatal(err)
		}
		if j := sr.GetJoin(); j != nil {
			go func() { // keep reading so LiveKit sees a live signal connection
				for {
					if _, _, err := ws.Read(context.Background()); err != nil {
						return
					}
				}
			}()
			return j
		}
	}
}

// App-level move against the real open-source LiveKit (ADR-0019), no fakes: LiveKit has no
// MoveParticipant, so the moved device gets a working target-room token in VOICE_MOVED, is
// dropped from the old room after 5 s, and a device that never connects is rolled back.
func TestMoveAppLevel(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	carl := register(t, invite(t, o, ws.GetId()))
	src := room.GetId()
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "target"}, &cr)
	dst := cr.GetRoom().GetId()
	name := func(rid string) string { return "ws_" + ws.GetId() + "_room_" + rid }
	og := dialGW(t)
	og.identify(o.token)
	bg := dialGW(t)
	bg.identify(bob.token)

	join := func(u *user) string {
		var j v1.JoinVoiceResponse
		u.must(200, "POST", "/api/rooms/"+src+"/join", nil, &j)
		webhook(t, whEvent("participant_joined", name(src), j.GetIdentity(), nil), "secret")
		og.wait("in the source room", func(e *v1.DispatchEvent) bool {
			s := e.GetVoiceStateUpdate().GetState()
			return s.GetUserId() == u.id && s.GetRoomId() == src
		})
		return j.GetIdentity()
	}
	bi := join(bob)
	lkJoin(t, name(src), bi) // bob's device really is in the source room
	join(carl)               // carl's device will never connect to the target

	o.must(204, "POST", "/api/rooms/"+src+"/voice/"+bob.id+"/move", &v1.MoveMemberRequest{TargetRoomId: dst}, nil)
	o.must(204, "POST", "/api/rooms/"+src+"/voice/"+carl.id+"/move", &v1.MoveMemberRequest{TargetRoomId: dst}, nil)
	moved := time.Now()

	mv := bg.wait("VOICE_MOVED with a token", func(e *v1.DispatchEvent) bool { return e.GetVoiceMoved().GetToken() != "" }).GetVoiceMoved()
	if mv.GetFromRoomId() != src || mv.GetToRoomId() != dst || mv.GetByUserId() != o.id || mv.GetSessionId() != bob.session ||
		mv.GetIdentity() != bi || mv.GetUrl() == "" {
		t.Fatalf("VOICE_MOVED: %v", mv)
	}
	og.wait("bob in the target room", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == bob.id && s.GetRoomId() == dst
	})

	// The token works: LiveKit admits the device into the target room with its identity.
	j := signalJoin(t, mv.GetToken())
	if j.GetRoom().GetName() != name(dst) || j.GetParticipant().GetIdentity() != bi {
		t.Fatalf("joined %q as %q", j.GetRoom().GetName(), j.GetParticipant().GetIdentity())
	}
	if !j.GetParticipant().GetPermission().GetCanSubscribe() {
		t.Fatal("target grant cannot subscribe")
	}
	webhook(t, whEvent("participant_joined", name(dst), bi, nil), "secret")

	// After 5 s the old room no longer holds the device (lk stayed connected there).
	time.Sleep(time.Until(moved.Add(5*time.Second + 700*time.Millisecond)))
	if _, err := lkRec.GetParticipant(context.Background(), name(src), bi); !rtc.IsNotFound(err) {
		t.Fatalf("moved device still in the old room: %v", err)
	}

	// After 15 s carl, who never connected, is rolled back; bob stays in the target.
	time.Sleep(time.Until(moved.Add(14500 * time.Millisecond)))
	og.wait("carl rolled back", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == carl.id && s.GetRoomId() == ""
	})
	if time.Since(moved) < 14*time.Second {
		t.Fatalf("rolled back too early: %v", time.Since(moved))
	}
	for _, s := range dialGW(t).identify(carl.token).GetWorkspaces() {
		for _, vs := range s.GetVoiceStates() {
			if vs.GetUserId() == bob.id && vs.GetRoomId() != dst {
				t.Fatalf("bob was rolled back although he connected: %v", vs)
			}
		}
	}
}
