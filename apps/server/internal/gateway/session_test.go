package gateway

import (
	"strconv"
	"testing"

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
	s.emit(uuid.New(), &v1.DispatchEvent{Event: &v1.DispatchEvent_Ready{Ready: &v1.Ready{}}})
	s.flushPending(map[uuid.UUID]bool{ids[0]: true})
	s.mu.Unlock()
	s.dispatch(ids[2], typingEv(2))
	got := drain(s)
	if len(got) != 3 {
		t.Fatalf("emitted %d frames, want 3", len(got))
	}
	for i, e := range got {
		if e.seq != uint64(i+1) {
			t.Fatalf("frame %d has seq %d", i, e.seq)
		}
		f := &v1.GatewayFrame{}
		if err := proto.Unmarshal(e.frame, f); err != nil || f.GetSeq() != e.seq || f.GetOp() != v1.GatewayOpcode_GATEWAY_OPCODE_DISPATCH {
			t.Fatalf("frame %d: %v %v", i, f, err)
		}
	}
	if got[1].id != ids[1] || got[2].id != ids[2] {
		t.Fatal("wrong order / skip")
	}
	// Dead sessions drop events.
	s.dead = true
	s.dispatch(uuid.New(), typingEv(3))
	if len(drain(s)) != 0 {
		t.Fatal("dead session emitted")
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
