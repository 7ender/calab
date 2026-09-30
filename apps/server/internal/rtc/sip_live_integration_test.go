//go:build integration

package rtc

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestSIPLive runs our SIP API client against a real LiveKit with livekit/sip attached
// (TEST_LIVEKIT_SIP=1; dev: `docker compose -f infra/docker/compose.dev.yml --profile sip up -d
// sip`): trunk create / replace / delete and a call to an unreachable provider, which must fail
// with a readable error instead of hanging.
func TestSIPLive(t *testing.T) {
	if os.Getenv("TEST_LIVEKIT_SIP") != "1" {
		t.Skip("TEST_LIVEKIT_SIP=1 runs against a LiveKit with the SIP service")
	}
	url := os.Getenv("TEST_LIVEKIT_INTERNAL_URL")
	if url == "" {
		url = "http://localhost:7880"
	}
	ctx := context.Background()
	s, lk := NewSIP(url, "devkey", "secret"), NewLiveKit(url, "devkey", "secret")
	trunk := SIPTrunk{Name: "calab-live-test", Address: "192.0.2.1:5060", Transport: SIPTransportUDP,
		Numbers: []string{"+74951234567"}, AuthUsername: "u", AuthPassword: "p"}
	tr, err := s.CreateSIPOutboundTrunk(ctx, trunk)
	if err != nil || tr.ID == "" {
		t.Fatalf("create trunk: %+v %v", tr, err)
	}
	defer func() { _ = s.DeleteSIPTrunk(ctx, tr.ID) }()
	trunk.Transport = SIPTransportTCP
	up, err := s.UpdateSIPOutboundTrunk(ctx, tr.ID, trunk)
	if err != nil || up.ID != tr.ID {
		t.Fatalf("replace trunk: %+v %v", up, err)
	}
	room := "sip-live_" + uuid.NewString()
	if err := lk.CreateRoom(ctx, room, 30, 5); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lk.DeleteRoom(ctx, room) }()
	identity := SIPIdentity(uuid.New())
	start := time.Now()
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	_, err = s.CreateSIPParticipant(cctx, SIPCall{TrunkID: tr.ID, CallTo: "79161234567", Room: room, Identity: identity,
		Name: "+79161234567", WaitUntilAnswered: true, RingingTimeout: 5 * time.Second, MaxCallDuration: 10 * time.Second})
	code, text := SIPStatus(err)
	t.Logf("call to an unreachable provider after %v: %v (sip %d %q)", time.Since(start).Round(time.Millisecond), err, code, text)
	if err == nil {
		t.Fatal("a call to 192.0.2.1 succeeded")
	}
	if err := s.DeleteSIPTrunk(ctx, tr.ID); err != nil {
		t.Fatalf("delete trunk: %v", err)
	}
	if _, err := s.UpdateSIPOutboundTrunk(ctx, tr.ID, trunk); !IsNotFound(err) {
		t.Fatalf("replace a deleted trunk: %v, want not_found", err)
	}
}
