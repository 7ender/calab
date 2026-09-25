package gateway

import (
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// testSession has no buffer writer; emitted entries stay in wq for inspection.
func testSession() *Session {
	return &Session{id: uuid.New(), user: uuid.New(), workspaces: map[uuid.UUID]bool{},
		subscribed: map[uuid.UUID]bool{}, wq: make(chan entry, 64)}
}

func typingEv(n int) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_TypingStart{TypingStart: &v1.TypingStart{RoomId: "r" + strconv.Itoa(n)}}}
}

func drain(s *Session) []entry {
	var out []entry
	for {
		select {
		case e := <-s.wq:
			out = append(out, e)
		default:
			return out
		}
	}
}

func decode(t *testing.T, e entry) *v1.GatewayFrame {
	t.Helper()
	f := &v1.GatewayFrame{}
	if err := proto.Unmarshal(e.frame, f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestSessionSeqPendingDedup(t *testing.T) {
	s := testSession()
	ids := []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}
	// Before READY events are queued, not numbered.
	s.dispatch(ids[0], typingEv(0))
	s.dispatch(ids[1], typingEv(1))
	s.dispatch(ids[1], typingEv(1)) // same event via a second channel: dropped
	if len(s.pending) != 2 || len(drain(s)) != 0 {
		t.Fatalf("pending=%d", len(s.pending))
	}
	// READY takes seq 1, then pending events follow in order; skipped ids are not re-sent.
	s.mu.Lock()
	s.ready = true
	s.emit(uuid.New(), newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_Ready{Ready: &v1.Ready{}}}))
	s.flushPending(map[uuid.UUID]bool{ids[0]: true})
	s.mu.Unlock()
	s.dispatch(ids[2], typingEv(2))
	got := drain(s)
	if len(got) != 3 {
		t.Fatalf("emitted %d frames, want 3", len(got))
	}
	for i, e := range got {
		f := decode(t, e)
		if e.seq != uint64(i+1) || f.GetSeq() != e.seq || f.GetOp() != v1.GatewayOpcode_GATEWAY_OPCODE_DISPATCH {
			t.Fatalf("frame %d: seq %d, %v", i, e.seq, f)
		}
	}
	if got[1].id != ids[1] || got[2].id != ids[2] || decode(t, got[2]).GetDispatch().GetTypingStart().GetRoomId() != "r2" {
		t.Fatal("wrong order / skip")
	}
	s.dead = true
	s.dispatch(uuid.New(), typingEv(3))
	if len(drain(s)) != 0 {
		t.Fatal("dead session emitted")
	}
}

func TestFrameBytesMatchesProto(t *testing.T) {
	ev := typingEv(7)
	enc := newEnc(ev)
	payload, _ := enc.bytes()
	got := frameBytes(42, payload)
	want, _ := proto.Marshal(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_DISPATCH, Seq: 42,
		Payload: &v1.GatewayFrame_Dispatch{Dispatch: ev}})
	f1, f2 := &v1.GatewayFrame{}, &v1.GatewayFrame{}
	if proto.Unmarshal(got, f1) != nil || proto.Unmarshal(want, f2) != nil || !proto.Equal(f1, f2) {
		t.Fatalf("hand-built frame differs: %v vs %v", f1, f2)
	}
	p2, _ := enc.bytes()
	if &p2[0] != &payload[0] {
		t.Fatal("event encoded twice")
	}
}

func TestPauseKeepsOrder(t *testing.T) {
	s := testSession()
	s.ready = true
	s.dispatch(uuid.New(), typingEv(0)) // seq 1, live
	marker := s.pause()
	s.dispatch(uuid.New(), typingEv(1)) // after the pause: waits
	if len(drain(s)) != 1 {
		t.Fatal("event emitted while paused")
	}
	s.resume(marker, uuid.New(), newEnc(typingEv(9))) // the prepared snapshot goes first
	got := drain(s)
	if len(got) != 2 || decode(t, got[0]).GetDispatch().GetTypingStart().GetRoomId() != "r9" ||
		decode(t, got[1]).GetDispatch().GetTypingStart().GetRoomId() != "r1" {
		t.Fatalf("order after resume: %d frames", len(got))
	}
}

func TestInboundBucket(t *testing.T) {
	c := &conn{tokens: inboundBurst, last: time.Now()}
	n := 0
	for c.allowInbound() {
		n++
		if n > 100 {
			break
		}
	}
	if n != inboundBurst {
		t.Fatalf("burst %d, want %d", n, inboundBurst)
	}
	c.last = c.last.Add(-time.Second) // 1 s later: 2 more
	a, b, third := c.allowInbound(), c.allowInbound(), c.allowInbound()
	if !a || !b || third {
		t.Fatal("refill rate")
	}
}

func TestSubscribeCap(t *testing.T) {
	s := testSession()
	ids := make([]string, 150)
	for i := range ids {
		ids[i] = uuid.NewString()
	}
	s.setSubscribed(append(ids, "garbage"))
	if len(s.subscribed) != maxSubscribed {
		t.Fatalf("subscribed %d rooms", len(s.subscribed))
	}
}
