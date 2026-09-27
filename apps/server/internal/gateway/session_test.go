package gateway

import (
	"strconv"
	"strings"
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

func roomEv(n int) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageDelete{MessageDelete: &v1.MessageDelete{RoomId: "r" + strconv.Itoa(n)}}}
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
	s.dispatch(ids[0], roomEv(0))
	s.dispatch(ids[1], roomEv(1))
	s.dispatch(ids[1], roomEv(1)) // same event via a second channel: dropped
	if len(s.pending) != 2 || len(drain(s)) != 0 {
		t.Fatalf("pending=%d", len(s.pending))
	}
	// READY takes seq 1, then pending events follow in order; skipped ids are not re-sent.
	s.mu.Lock()
	s.ready = true
	s.emit(uuid.New(), newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_Ready{Ready: &v1.Ready{}}}))
	s.flushPending(map[uuid.UUID]bool{ids[0]: true})
	s.mu.Unlock()
	s.dispatch(ids[2], roomEv(2))
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
	if got[1].id != ids[1] || got[2].id != ids[2] || decode(t, got[2]).GetDispatch().GetMessageDelete().GetRoomId() != "r2" {
		t.Fatal("wrong order / skip")
	}
	s.dead = true
	s.dispatch(uuid.New(), roomEv(3))
	if len(drain(s)) != 0 {
		t.Fatal("dead session emitted")
	}
}

func TestFrameBytesMatchesProto(t *testing.T) {
	ev := roomEv(7)
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
	s.dispatch(uuid.New(), roomEv(0)) // seq 1, live
	marker := s.pause()
	s.dispatch(uuid.New(), roomEv(1)) // after the pause: waits
	if len(drain(s)) != 1 {
		t.Fatal("event emitted while paused")
	}
	s.resume(marker, uuid.New(), newEnc(roomEv(9))) // the prepared snapshot goes first
	got := drain(s)
	if len(got) != 2 || decode(t, got[0]).GetDispatch().GetMessageDelete().GetRoomId() != "r9" ||
		decode(t, got[1]).GetDispatch().GetMessageDelete().GetRoomId() != "r1" {
		t.Fatalf("order after resume: %d frames", len(got))
	}
}

// B1: two overlapping pauses keep their insertion points whichever resumes first.
func TestOverlappingPauses(t *testing.T) {
	for _, aFirst := range []bool{true, false} {
		s := testSession()
		s.ready = true
		a := s.pause()
		s.dispatch(uuid.New(), roomEv(1))
		b := s.pause()
		s.dispatch(uuid.New(), roomEv(2))
		first, second := func() { s.resume(a, uuid.New(), newEnc(roomEv(7))) }, func() { s.resume(b, uuid.New(), newEnc(roomEv(8))) }
		if !aFirst {
			first, second = second, first
		}
		first()
		if len(drain(s)) != 0 {
			t.Fatal("emitted while the other pause is open")
		}
		second()
		var rooms []string
		for _, e := range drain(s) {
			rooms = append(rooms, decode(t, e).GetDispatch().GetMessageDelete().GetRoomId())
		}
		if strings.Join(rooms, ",") != "r7,r1,r8,r2" {
			t.Fatalf("aFirst=%v: order %v", aFirst, rooms)
		}
	}
}

func TestInboundBucket(t *testing.T) {
	c := &conn{tokens: inboundBurst, flood: floodBurst, last: time.Now()}
	allowed, dropped := 0, 0
	for i := 0; i < floodBurst; i++ {
		ok, flood := c.inbound()
		if flood {
			t.Fatalf("flood at frame %d, within the hard burst", i)
		}
		if ok {
			allowed++
		} else {
			dropped++
		}
	}
	if allowed != inboundBurst || dropped != floodBurst-inboundBurst {
		t.Fatalf("allowed %d dropped %d", allowed, dropped)
	}
	if _, flood := c.inbound(); !flood {
		t.Fatal("sustained flooding not detected")
	}
	c.last = c.last.Add(-time.Second) // 1 s later: 2 soft tokens again
	a, _ := c.inbound()
	b, _ := c.inbound()
	third, _ := c.inbound()
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

// R6: ids replayed after a takeover stay skipped even if a pause postpones the flush.
func TestSkipSurvivesPause(t *testing.T) {
	s := testSession()
	x, y := uuid.New(), uuid.New()
	s.dispatch(x, roomEv(1))
	s.dispatch(y, roomEv(2))
	marker := s.pause()
	s.mu.Lock()
	s.ready = true
	s.flushPending(map[uuid.UUID]bool{x: true}) // paused: nothing yet
	s.mu.Unlock()
	if len(drain(s)) != 0 {
		t.Fatal("emitted while paused")
	}
	s.resume(marker, uuid.New(), newEnc(roomEv(9)))
	got := drain(s)
	var rooms []string
	for _, e := range got {
		rooms = append(rooms, decode(t, e).GetDispatch().GetMessageDelete().GetRoomId())
	}
	if len(got) != 2 || rooms[0] != "r2" || rooms[1] != "r9" {
		t.Fatalf("after resume: %v (x must stay skipped)", rooms)
	}
}

// docs/18 step 7: TYPING_START is ephemeral — no seq, nothing for the resume buffer; the seq
// of the next real event stays contiguous.
func TestTypingNotBuffered(t *testing.T) {
	s := testSession()
	s.ready = true
	s.dispatch(uuid.New(), roomEv(1))
	s.dispatch(uuid.New(), &v1.DispatchEvent{Event: &v1.DispatchEvent_TypingStart{TypingStart: &v1.TypingStart{RoomId: "r"}}})
	s.dispatch(uuid.New(), roomEv(2))
	got := drain(s)
	if len(got) != 2 || got[0].seq != 1 || got[1].seq != 2 || s.seq != 2 {
		t.Fatalf("buffered %d entries, seq %d", len(got), s.seq)
	}
	f := &v1.GatewayFrame{}
	if err := proto.Unmarshal(frameBytes(0, nil), f); err != nil || f.GetSeq() != 0 || f.GetOp() != v1.GatewayOpcode_GATEWAY_OPCODE_DISPATCH {
		t.Fatalf("ephemeral frame: %v %v", f, err)
	}
}
