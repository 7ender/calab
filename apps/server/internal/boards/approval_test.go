package boards

import (
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

func TestQuorum(t *testing.T) {
	for _, c := range []struct{ required, n, want int }{
		{0, 0, 0}, {0, 3, 3}, {2, 3, 2}, {3, 3, 3}, {5, 3, 3}, {1, 1, 1},
	} {
		if got := Quorum(c.required, c.n); got != c.want {
			t.Errorf("Quorum(%d, %d) = %d, want %d", c.required, c.n, got, c.want)
		}
	}
}

func TestApprovalState(t *testing.T) {
	const (
		none     = v1.TaskApprovalState_TASK_APPROVAL_STATE_NONE
		pending  = v1.TaskApprovalState_TASK_APPROVAL_STATE_PENDING
		approved = v1.TaskApprovalState_TASK_APPROVAL_STATE_APPROVED
		rejected = v1.TaskApprovalState_TASK_APPROVAL_STATE_REJECTED
	)
	for _, c := range []struct {
		name     string
		states   []string
		required int
		want     v1.TaskApprovalState
	}{
		{"no approvers", nil, 0, none},
		{"no approvers, stale quorum", nil, 2, none},
		{"all: one pending", []string{voteApproved, votePending}, 0, pending},
		{"all: every one approved", []string{voteApproved, voteApproved}, 0, approved},
		{"2 of 3 reached", []string{voteApproved, votePending, voteApproved}, 2, approved},
		{"2 of 3 not yet", []string{voteApproved, votePending, votePending}, 2, pending},
		{"veto beats the quorum", []string{voteApproved, voteApproved, voteRejected}, 2, rejected},
		{"veto with all", []string{voteRejected}, 0, rejected},
		{"quorum above the count = all", []string{voteApproved, voteApproved}, 5, approved},
	} {
		tl := TallyOf(c.states, c.required)
		if got := tl.State(); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
		if tl.Blocks() != (c.want == pending || c.want == rejected) {
			t.Errorf("%s: Blocks %v", c.name, tl.Blocks())
		}
	}
	if s := TallyOf([]string{voteApproved, voteRejected}, 0).reset().State(); s != pending {
		t.Errorf("reset: %v", s)
	}
}

func TestApprovalGate(t *testing.T) {
	board, other := uuid.New(), uuid.New()
	st := func(b uuid.UUID, pos int32, typ string) sqlc.BoardStatus {
		return sqlc.BoardStatus{ID: uuid.New(), BoardID: b, Position: pos, Type: typ}
	}
	backlog, todo, doing, review := st(board, 0, "backlog"), st(board, 1, "unstarted"), st(board, 2, "started"), st(board, 3, "started")
	done, cancelled := st(board, 4, "completed"), st(board, 5, "cancelled")
	doneFirst := st(board, 0, "completed") // a COMPLETED column placed before others
	for _, c := range []struct {
		name     string
		from, to sqlc.BoardStatus
		forward  bool
	}{
		{"same column", doing, doing, false},
		{"forward", todo, doing, true},
		{"forward by two", backlog, review, true},
		{"backward", review, todo, false},
		{"into completed", doing, done, true},
		{"into a completed column placed first", doing, doneFirst, true},
		{"into cancelled after", doing, cancelled, false},
		{"completed back to started", done, doing, false},
		{"other board, same type", doing, st(other, 9, "started"), false},
		{"other board, into completed", doing, st(other, 0, "completed"), true},
		{"other board, completed stays completed", done, st(other, 0, "completed"), false},
	} {
		if got := Forward(c.from, c.to); got != c.forward {
			t.Errorf("%s: Forward %v, want %v", c.name, got, c.forward)
		}
	}

	pending := TallyOf([]string{voteApproved, votePending}, 0)
	err := checkApprovalGate(pending, todo, done)
	e := httpx.AsError(err)
	if err == nil || e.Status != 409 || e.Reason != ReasonTaskApprovalRequired || e.Used != 1 || e.Limit != 2 {
		t.Fatalf("pending forward: %v", err)
	}
	if err := checkApprovalGate(pending, done, todo); err != nil {
		t.Fatalf("pending backward: %v", err)
	}
	if err := checkApprovalGate(pending, todo, cancelled); err != nil {
		t.Fatalf("pending cancelled: %v", err)
	}
	if err := checkApprovalGate(TallyOf([]string{voteApproved, voteRejected}, 1), todo, doing); err == nil {
		t.Fatal("rejected forward allowed")
	}
	if err := checkApprovalGate(TallyOf([]string{voteApproved, votePending}, 1), todo, done); err != nil {
		t.Fatalf("approved forward: %v", err)
	}
	if err := checkApprovalGate(TallyOf(nil, 0), todo, done); err != nil {
		t.Fatalf("no approvers: %v", err)
	}
}
