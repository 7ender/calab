package calls

import (
	"errors"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Record is a call as stored in Valkey (call:<id>, JSON).
type Record struct {
	ID       uuid.UUID    `json:"id"`
	DM       uuid.UUID    `json:"dm"`
	Caller   uuid.UUID    `json:"from"`
	Callee   uuid.UUID    `json:"to"`
	State    v1.CallState `json:"st"`
	Created  int64        `json:"c"`           // unix ms
	Answered int64        `json:"a,omitempty"` // unix ms, ACTIVE and after
	Ended    int64        `json:"e,omitempty"` // unix ms, terminal states
	Reason   string       `json:"r,omitempty"` // ENDED: "hangup" | "lost"
	// Away (ACTIVE): participant id → unix ms since when they have no device in the DM's
	// voice session. Both start away at the answer; a device that joins clears the entry, the
	// last device that leaves sets it. An entry older than the lost grace ends the call.
	Away map[string]int64 `json:"away,omitempty"`
}

// Action is a transition of the call state machine (ADR-0034 §2).
type Action int

// Actions: the first four are the REST routes, the last two come from the server itself.
const (
	Accept  Action = iota + 1 // callee, RINGING → ACTIVE
	Decline                   // callee, RINGING → DECLINED
	Cancel                    // caller, RINGING → CANCELLED
	Hangup                    // either, ACTIVE → ENDED "hangup"
	Timeout                   // server, RINGING → MISSED
	Lost                      // server, ACTIVE → ENDED "lost"
)

// Reasons of an ENDED call.
const (
	ReasonHangup = "hangup"
	ReasonLost   = "lost"
)

// Errors of Apply; the handlers map them to 404 / 403 / 409.
var (
	ErrNotParticipant = errors.New("calls: not a participant")
	ErrWrongSide      = errors.New("calls: the other side's action")
	ErrState          = errors.New("calls: not allowed in this state")
)

// Terminal reports a finished call.
func Terminal(st v1.CallState) bool {
	switch st {
	case v1.CallState_CALL_STATE_ENDED, v1.CallState_CALL_STATE_DECLINED, v1.CallState_CALL_STATE_CANCELLED,
		v1.CallState_CALL_STATE_MISSED, v1.CallState_CALL_STATE_BUSY:
		return true
	}
	return false
}

// Participant reports whether u is the caller or the callee.
func (r Record) Participant(u uuid.UUID) bool { return u == r.Caller || u == r.Callee }

// Peer returns the other participant.
func (r Record) Peer(u uuid.UUID) uuid.UUID {
	if u == r.Caller {
		return r.Callee
	}
	return r.Caller
}

// Apply returns the record after action a by actor (uuid.Nil for the server's own actions)
// at now. r is not modified.
func (r Record) Apply(a Action, actor uuid.UUID, now time.Time) (Record, error) {
	if actor != uuid.Nil && !r.Participant(actor) {
		return r, ErrNotParticipant
	}
	want, side := v1.CallState_CALL_STATE_RINGING, uuid.Nil // side: who may act (Nil = either)
	var next v1.CallState
	switch a {
	case Accept:
		side, next = r.Callee, v1.CallState_CALL_STATE_ACTIVE
	case Decline:
		side, next = r.Callee, v1.CallState_CALL_STATE_DECLINED
	case Cancel:
		side, next = r.Caller, v1.CallState_CALL_STATE_CANCELLED
	case Hangup:
		want, next = v1.CallState_CALL_STATE_ACTIVE, v1.CallState_CALL_STATE_ENDED
	case Timeout:
		next = v1.CallState_CALL_STATE_MISSED
	case Lost:
		want, next = v1.CallState_CALL_STATE_ACTIVE, v1.CallState_CALL_STATE_ENDED
	default:
		return r, ErrState
	}
	if side != uuid.Nil && actor != side {
		return r, ErrWrongSide
	}
	if r.State != want {
		return r, ErrState
	}
	out := r
	out.State = next
	ms := now.UnixMilli()
	switch next {
	case v1.CallState_CALL_STATE_ACTIVE:
		out.Answered = ms
		out.Away = map[string]int64{r.Caller.String(): ms, r.Callee.String(): ms}
	default:
		out.Ended, out.Away = ms, nil
		switch a {
		case Hangup:
			out.Reason = ReasonHangup
		case Lost:
			out.Reason = ReasonLost
		}
	}
	return out, nil
}

// SetAway records whether participant u is in the DM's voice session now (ACTIVE only).
// changed = false when nothing is to be written.
func (r Record) SetAway(u uuid.UUID, present bool, now time.Time) (Record, bool) {
	if r.State != v1.CallState_CALL_STATE_ACTIVE || !r.Participant(u) {
		return r, false
	}
	_, away := r.Away[u.String()]
	if present != away {
		return r, false // already as it should be (an away user keeps their first time)
	}
	out := r
	out.Away = make(map[string]int64, 2)
	for k, v := range r.Away {
		out.Away[k] = v
	}
	if present {
		delete(out.Away, u.String())
	} else {
		out.Away[u.String()] = now.UnixMilli()
	}
	return out, true
}

// LostSince returns when the earliest participant still away left (ok = someone is away).
func (r Record) LostSince() (time.Time, bool) {
	var first int64
	for _, ms := range r.Away {
		if first == 0 || ms < first {
			first = ms
		}
	}
	return time.UnixMilli(first), first != 0
}

// Proto is the client view of the call.
func (r Record) Proto() *v1.Call {
	c := &v1.Call{
		Id: r.ID.String(), DmRoomId: r.DM.String(), CallerId: r.Caller.String(), CalleeId: r.Callee.String(),
		State: r.State, CreatedAt: timestamppb.New(time.UnixMilli(r.Created)), Reason: r.Reason,
	}
	if r.Answered != 0 {
		c.AnsweredAt = timestamppb.New(time.UnixMilli(r.Answered))
	}
	if r.Ended != 0 {
		c.EndedAt = timestamppb.New(time.UnixMilli(r.Ended))
	}
	return c
}

var outcomes = map[v1.CallState]v1.CallOutcome{
	v1.CallState_CALL_STATE_ENDED:     v1.CallOutcome_CALL_OUTCOME_ENDED,
	v1.CallState_CALL_STATE_MISSED:    v1.CallOutcome_CALL_OUTCOME_MISSED,
	v1.CallState_CALL_STATE_DECLINED:  v1.CallOutcome_CALL_OUTCOME_DECLINED,
	v1.CallState_CALL_STATE_CANCELLED: v1.CallOutcome_CALL_OUTCOME_CANCELLED,
	v1.CallState_CALL_STATE_BUSY:      v1.CallOutcome_CALL_OUTCOME_BUSY,
}

// Card is the DM log line of a finished call (SystemMessage.call).
func (r Record) Card() *v1.CallCard {
	c := &v1.CallCard{
		CallerId: r.Caller.String(), Outcome: outcomes[r.State], StartedAt: timestamppb.New(time.UnixMilli(r.Created)),
	}
	if r.State != v1.CallState_CALL_STATE_BUSY {
		c.CallId = r.ID.String()
	}
	if r.State == v1.CallState_CALL_STATE_ENDED && r.Answered != 0 && r.Ended > r.Answered {
		c.DurationSec = uint32((r.Ended - r.Answered) / 1000) //nolint:gosec // bounded by the 24 h TTL
	}
	return c
}
