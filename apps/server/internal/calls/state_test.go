package calls

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func ringing() Record {
	return Record{ID: uuid.New(), DM: uuid.New(), Caller: uuid.New(), Callee: uuid.New(),
		State: v1.CallState_CALL_STATE_RINGING, Created: time.Unix(1000, 0).UnixMilli()}
}

func TestApplyRules(t *testing.T) {
	r := ringing()
	now := time.Unix(1010, 0)
	stranger := uuid.New()
	cases := []struct {
		name  string
		from  v1.CallState
		a     Action
		actor uuid.UUID
		want  v1.CallState
		err   error
	}{
		{"callee accepts", v1.CallState_CALL_STATE_RINGING, Accept, r.Callee, v1.CallState_CALL_STATE_ACTIVE, nil},
		{"caller cannot accept", v1.CallState_CALL_STATE_RINGING, Accept, r.Caller, 0, ErrWrongSide},
		{"stranger cannot accept", v1.CallState_CALL_STATE_RINGING, Accept, stranger, 0, ErrNotParticipant},
		{"second accept", v1.CallState_CALL_STATE_ACTIVE, Accept, r.Callee, 0, ErrState},
		{"callee declines", v1.CallState_CALL_STATE_RINGING, Decline, r.Callee, v1.CallState_CALL_STATE_DECLINED, nil},
		{"caller cannot decline", v1.CallState_CALL_STATE_RINGING, Decline, r.Caller, 0, ErrWrongSide},
		{"decline after answer", v1.CallState_CALL_STATE_ACTIVE, Decline, r.Callee, 0, ErrState},
		{"caller cancels", v1.CallState_CALL_STATE_RINGING, Cancel, r.Caller, v1.CallState_CALL_STATE_CANCELLED, nil},
		{"callee cannot cancel", v1.CallState_CALL_STATE_RINGING, Cancel, r.Callee, 0, ErrWrongSide},
		{"cancel after answer", v1.CallState_CALL_STATE_ACTIVE, Cancel, r.Caller, 0, ErrState},
		{"caller hangs up", v1.CallState_CALL_STATE_ACTIVE, Hangup, r.Caller, v1.CallState_CALL_STATE_ENDED, nil},
		{"callee hangs up", v1.CallState_CALL_STATE_ACTIVE, Hangup, r.Callee, v1.CallState_CALL_STATE_ENDED, nil},
		{"hangup while ringing", v1.CallState_CALL_STATE_RINGING, Hangup, r.Caller, 0, ErrState},
		{"second hangup", v1.CallState_CALL_STATE_ENDED, Hangup, r.Callee, 0, ErrState},
		{"timeout", v1.CallState_CALL_STATE_RINGING, Timeout, uuid.Nil, v1.CallState_CALL_STATE_MISSED, nil},
		{"timeout after answer", v1.CallState_CALL_STATE_ACTIVE, Timeout, uuid.Nil, 0, ErrState},
		{"lost", v1.CallState_CALL_STATE_ACTIVE, Lost, uuid.Nil, v1.CallState_CALL_STATE_ENDED, nil},
		{"lost while ringing", v1.CallState_CALL_STATE_RINGING, Lost, uuid.Nil, 0, ErrState},
		{"server cannot accept", v1.CallState_CALL_STATE_RINGING, Accept, uuid.Nil, 0, ErrWrongSide},
	}
	for _, c := range cases {
		in := r
		in.State = c.from
		out, err := in.Apply(c.a, c.actor, now)
		if !errors.Is(err, c.err) {
			t.Errorf("%s: err %v, want %v", c.name, err, c.err)
			continue
		}
		if err == nil && out.State != c.want {
			t.Errorf("%s: state %v, want %v", c.name, out.State, c.want)
		}
		if err != nil && out.State != c.from {
			t.Errorf("%s: a refused action changed the state", c.name)
		}
	}
}

func TestLifecycleAndCard(t *testing.T) {
	r := ringing()
	a, err := r.Apply(Accept, r.Callee, time.Unix(1005, 0))
	if err != nil || a.Answered != time.Unix(1005, 0).UnixMilli() || len(a.Away) != 2 {
		t.Fatalf("accept: %+v %v", a, err)
	}
	if r.State != v1.CallState_CALL_STATE_RINGING {
		t.Fatal("Apply modified its receiver")
	}
	// Both join, the callee drops out and comes back: the away time is the first leave.
	a, _ = a.SetAway(a.Caller, true, time.Unix(1006, 0))
	a, _ = a.SetAway(a.Callee, true, time.Unix(1006, 0))
	if _, away := a.LostSince(); away {
		t.Fatalf("both joined, still away: %v", a.Away)
	}
	a, ch := a.SetAway(a.Callee, false, time.Unix(1100, 0))
	if !ch {
		t.Fatal("leave not recorded")
	}
	if _, ch := a.SetAway(a.Callee, false, time.Unix(1110, 0)); ch {
		t.Fatal("a second leave moved the away time")
	}
	if since, away := a.LostSince(); !away || !since.Equal(time.Unix(1100, 0)) {
		t.Fatalf("lost since %v %v", since, away)
	}
	if _, ch := a.SetAway(uuid.New(), false, time.Unix(1110, 0)); ch {
		t.Fatal("a stranger's presence recorded")
	}
	e, err := a.Apply(Hangup, a.Caller, time.Unix(1317, 500_000_000))
	if err != nil || e.Reason != ReasonHangup || e.Away != nil {
		t.Fatalf("hangup: %+v %v", e, err)
	}
	if _, ch := e.SetAway(e.Caller, false, time.Unix(1400, 0)); ch {
		t.Fatal("presence recorded on an ended call")
	}
	card := e.Card()
	if card.GetOutcome() != v1.CallOutcome_CALL_OUTCOME_ENDED || card.GetDurationSec() != 312 || card.GetCallerId() != r.Caller.String() ||
		card.GetCallId() != r.ID.String() || !card.GetStartedAt().AsTime().Equal(time.Unix(1000, 0)) {
		t.Fatalf("card: %v", card)
	}
	pb := e.Proto()
	if pb.GetState() != v1.CallState_CALL_STATE_ENDED || pb.GetAnsweredAt() == nil || pb.GetEndedAt() == nil || pb.GetReason() != "hangup" {
		t.Fatalf("proto: %v", pb)
	}
	lost, _ := a.Apply(Lost, uuid.Nil, time.Unix(1200, 0))
	if lost.Reason != ReasonLost {
		t.Fatalf("lost reason %q", lost.Reason)
	}
}

func TestCardOutcomes(t *testing.T) {
	for st, want := range map[v1.CallState]v1.CallOutcome{
		v1.CallState_CALL_STATE_MISSED:    v1.CallOutcome_CALL_OUTCOME_MISSED,
		v1.CallState_CALL_STATE_DECLINED:  v1.CallOutcome_CALL_OUTCOME_DECLINED,
		v1.CallState_CALL_STATE_CANCELLED: v1.CallOutcome_CALL_OUTCOME_CANCELLED,
		v1.CallState_CALL_STATE_BUSY:      v1.CallOutcome_CALL_OUTCOME_BUSY,
	} {
		r := ringing()
		r.State, r.Ended = st, r.Created+5000
		c := r.Card()
		if c.GetOutcome() != want || c.GetDurationSec() != 0 {
			t.Errorf("%v: %v", st, c)
		}
		if (c.GetCallId() == "") != (st == v1.CallState_CALL_STATE_BUSY) {
			t.Errorf("%v: call id %q", st, c.GetCallId())
		}
		if !Terminal(st) {
			t.Errorf("%v not terminal", st)
		}
	}
	if Terminal(v1.CallState_CALL_STATE_RINGING) || Terminal(v1.CallState_CALL_STATE_ACTIVE) {
		t.Fatal("live states reported terminal")
	}
}
