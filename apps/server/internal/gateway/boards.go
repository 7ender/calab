package gateway

import (
	"context"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/boards"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// Task boards in the workspace state (ADR-0042 §4): the live boards with their overrides and
// the comment room of every task, so board and task events and the messages of task rooms are
// filtered per recipient without DB queries, like rooms.

type taskRoom struct {
	board    uuid.UUID
	task     uuid.UUID
	archived bool
}

// boardState is the boards part of wsState (mu of the workspace held).
type boardState struct {
	boards    map[uuid.UUID]*v1.Board
	btargets  map[uuid.UUID][]perm.OverrideTarget
	taskRooms map[uuid.UUID]taskRoom  // room → task
	roomOf    map[uuid.UUID]uuid.UUID // task → room
}

func (b *boardState) init() {
	if b.boards == nil {
		b.boards = map[uuid.UUID]*v1.Board{}
		b.btargets = map[uuid.UUID][]perm.OverrideTarget{}
		b.taskRooms = map[uuid.UUID]taskRoom{}
		b.roomOf = map[uuid.UUID]uuid.UUID{}
	}
}

func (b *boardState) setBoard(id uuid.UUID, pb *v1.Board) {
	b.init()
	b.boards[id] = pb
	b.btargets[id] = pbconv.ProtoOverrideTargets(pb.GetPermissionOverrides())
}

func (b *boardState) delBoard(id uuid.UUID) {
	delete(b.boards, id)
	delete(b.btargets, id)
	for rid, tr := range b.taskRooms {
		if tr.board == id {
			delete(b.taskRooms, rid)
			delete(b.roomOf, tr.task)
		}
	}
}

func (b *boardState) setTask(t *v1.Task) {
	b.init()
	rid, tid := parseID(t.GetRoomId()), parseID(t.GetId())
	if rid == uuid.Nil {
		return
	}
	b.taskRooms[rid] = taskRoom{board: parseID(t.GetBoardId()), task: tid, archived: t.GetArchivedAt() != nil}
	b.roomOf[tid] = rid
}

func loadBoards(ctx context.Context, q *sqlc.Queries, wid uuid.UUID, st *wsState) error {
	bs, err := boards.All(ctx, q, wid)
	if err != nil {
		return err
	}
	for _, b := range bs {
		st.setBoard(parseID(b.GetId()), b)
	}
	trs, err := q.ListWorkspaceTaskRooms(ctx, wid)
	if err != nil {
		return err
	}
	st.init()
	for _, t := range trs {
		st.taskRooms[t.RoomID] = taskRoom{board: t.BoardID, task: t.ID, archived: t.Archived}
		st.roomOf[t.ID] = t.RoomID
	}
	return nil
}

// boardBits: a member's bits on a live board (mu held).
func (s *wsState) boardBits(boardID, userID uuid.UUID) perm.Bits {
	m, ok := s.members[userID]
	b := s.boards[boardID]
	if !ok || b == nil {
		return 0
	}
	return perm.ComputeBoardIn(m, b.GetIsPrivate(), s.btargets[boardID])
}

// taskRoomBits: a member's bits in a task's comment room (0 = not a task room of a live board).
func (s *wsState) taskRoomBits(roomID, userID uuid.UUID) perm.Bits {
	tr, ok := s.taskRooms[roomID]
	if !ok {
		return 0
	}
	return perm.TaskRoom(s.boardBits(tr.board, userID), tr.archived)
}

// forRecipient is a board event as one recipient gets it: with their bits.
func forRecipient(ev *v1.DispatchEvent, bits perm.Bits) *v1.DispatchEvent {
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_BoardCreate:
		b := proto.CloneOf(e.BoardCreate.GetBoard())
		b.Permissions = uint64(bits)
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardCreate{BoardCreate: &v1.BoardCreate{Board: b}}}
	case *v1.DispatchEvent_BoardUpdate:
		b := proto.CloneOf(e.BoardUpdate.GetBoard())
		b.Permissions = uint64(bits)
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardUpdate{BoardUpdate: &v1.BoardUpdate{Board: b}}}
	}
	return ev
}

// boardTransition turns a board change for one recipient into what they should see.
func boardTransition(before, after perm.Bits, board *v1.Board, wid uuid.UUID, changed *v1.DispatchEvent) *v1.DispatchEvent {
	was, is := before.Has(perm.ViewBoard), after.Has(perm.ViewBoard)
	switch {
	case was && is && changed != nil:
		return forRecipient(changed, after)
	case !was && is:
		return forRecipient(&v1.DispatchEvent{Event: &v1.DispatchEvent_BoardCreate{BoardCreate: &v1.BoardCreate{Board: board}}}, after)
	case was && !is:
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardDelete{BoardDelete: &v1.BoardDelete{WorkspaceId: wid.String(), BoardId: board.GetId()}}}
	}
	return nil
}

// routeBoards delivers board and task events (st.mu held); false = not a board event.
func (h *Hub) routeBoards(st *wsState, wid, id uuid.UUID, sessions []*Session, ev *v1.DispatchEvent) bool {
	toBoard := func(boardID uuid.UUID) {
		shared := newEnc(ev)
		for _, s := range sessions {
			if st.boardBits(boardID, s.user).Has(perm.ViewBoard) {
				s.dispatchEnc(id, shared)
			}
		}
	}
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_BoardCreate, *v1.DispatchEvent_BoardUpdate:
		b := ev.GetBoardCreate().GetBoard()
		if b == nil {
			b = ev.GetBoardUpdate().GetBoard()
		}
		bid := parseID(b.GetId())
		before := make(map[*Session]perm.Bits, len(sessions))
		for _, s := range sessions {
			before[s] = st.boardBits(bid, s.user)
		}
		st.setBoard(bid, b)
		for _, s := range sessions {
			after := st.boardBits(bid, s.user)
			changed := ev
			if before[s].Has(perm.ViewBoard) && !after.Has(perm.ViewBoard) {
				changed = nil
			}
			if out := boardTransition(before[s], after, b, wid, changed); out != nil {
				s.dispatch(id, out)
			}
		}
	case *v1.DispatchEvent_BoardDelete:
		bid := parseID(e.BoardDelete.GetBoardId())
		toBoard(bid)
		st.delBoard(bid)
	case *v1.DispatchEvent_TaskCreate:
		st.setTask(e.TaskCreate.GetTask())
		toBoard(parseID(e.TaskCreate.GetTask().GetBoardId()))
	case *v1.DispatchEvent_TaskUpdate:
		st.setTask(e.TaskUpdate.GetTask())
		toBoard(parseID(e.TaskUpdate.GetTask().GetBoardId()))
	case *v1.DispatchEvent_TaskDelete:
		toBoard(parseID(e.TaskDelete.GetBoardId()))
		tid := parseID(e.TaskDelete.GetTaskId())
		if rid, ok := st.roomOf[tid]; ok {
			tr := st.taskRooms[rid]
			if e.TaskDelete.GetPurged() {
				delete(st.taskRooms, rid)
				delete(st.roomOf, tid)
			} else if tr.board == parseID(e.TaskDelete.GetBoardId()) {
				tr.archived = true
				st.taskRooms[rid] = tr
			}
		}
	case *v1.DispatchEvent_TaskActivity:
		toBoard(parseID(e.TaskActivity.GetActivity().GetBoardId()))
	default:
		return false
	}
	return true
}

// reviewBoards runs apply and then sends the sessions of users matching who BOARD_CREATE /
// BOARD_DELETE for boards they gained / lost with it (role and member changes; st.mu held).
func (h *Hub) reviewBoards(st *wsState, wid uuid.UUID, sessions []*Session, who func(uuid.UUID) bool, apply func()) {
	before := map[*Session]map[uuid.UUID]perm.Bits{}
	for _, s := range sessions {
		if !who(s.user) || len(st.boards) == 0 {
			continue
		}
		v := make(map[uuid.UUID]perm.Bits, len(st.boards))
		for bid := range st.boards {
			v[bid] = st.boardBits(bid, s.user)
		}
		before[s] = v
	}
	apply()
	for s, was := range before {
		for bid, b := range st.boards {
			if out := boardTransition(was[bid], st.boardBits(bid, s.user), b, wid, nil); out != nil {
				s.dispatch(uuid.New(), out)
			}
		}
	}
}
