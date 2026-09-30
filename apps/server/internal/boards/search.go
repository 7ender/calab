package boards

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// VisibleBoards returns the live boards of a workspace member m sees, with their bits.
func VisibleBoards(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID, m perm.Member) (map[uuid.UUID]perm.Bits, error) {
	out := map[uuid.UUID]perm.Bits{}
	if m.Role == perm.RoleGuest || m.Role == "" {
		return out, nil
	}
	rows, err := q.ListBoards(ctx, sqlc.ListBoardsParams{WorkspaceID: wsID, Archived: false})
	if err != nil || len(rows) == 0 {
		return out, err
	}
	ovs, err := q.ListWorkspaceBoardOverrides(ctx, wsID)
	if err != nil {
		return nil, err
	}
	by := map[uuid.UUID][]sqlc.BoardPermission{}
	for _, o := range ovs {
		by[o.BoardID] = append(by[o.BoardID], o)
	}
	for _, b := range rows {
		if bits := perm.ComputeBoardIn(m, b.IsPrivate, b.Restricted, OverrideTargets(by[b.ID])); bits.Has(perm.ViewBoard) {
			out[b.ID] = bits
		}
	}
	return out, nil
}

// MemberOpenTasks is the most tasks of a member profile (ADR-0051).
const MemberOpenTasks = 50

// OpenTasksOf returns the open tasks (status not completed / cancelled, not archived) assigned
// to user on the boards of wsID that viewer (a member of wsID) sees, most recently updated
// first, at most MemberOpenTasks: the tasks of a member profile (ADR-0051). Guests see none.
func OpenTasksOf(ctx context.Context, dbtx sqlc.DBTX, q *sqlc.Queries, wsID uuid.UUID, viewer perm.Member, viewerID, user uuid.UUID) ([]*v1.Task, error) {
	vis, err := VisibleBoards(ctx, q, wsID, viewer)
	if err != nil || len(vis) == 0 {
		return []*v1.Task{}, err
	}
	var a Args
	rows, err := queryTasks(ctx, dbtx, "WHERE t.board_id = ANY("+a.Add(keys(vis))+"::uuid[]) AND t.archived_at IS NULL"+
		" AND EXISTS (SELECT 1 FROM task_assignees x WHERE x.task_id = t.id AND x.user_id = "+a.Add(user)+")"+
		" AND t.status_id IN (SELECT st.id FROM board_statuses st WHERE st.type NOT IN ('completed', 'cancelled'))"+
		" ORDER BY t.updated_at DESC, t.id DESC LIMIT "+strconv.Itoa(MemberOpenTasks), a.Values()...)
	if err != nil {
		return nil, err
	}
	out, err := tasksProto(ctx, q, rows, viewerID)
	if out == nil && err == nil {
		out = []*v1.Task{}
	}
	return out, err
}

func keys(m map[uuid.UUID]perm.Bits) []uuid.UUID {
	out := make([]uuid.UUID, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// myTasks: GET /api/me/tasks?workspace_id=&scope=assigned|lead|created|subscribed&open=1&cursor=
// — the caller's tasks on the boards they see, newest update first.
func (s *Service) myTasks(w http.ResponseWriter, r *http.Request) error {
	qs := r.URL.Query()
	me := uid(r)
	var wss []uuid.UUID
	if raw := qs.Get("workspace_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return httpx.BadRequest("workspace_id must be a workspace id")
		}
		wss = []uuid.UUID{id}
	} else {
		ids, err := s.db.Q.ListUserWorkspaceIDs(r.Context(), me)
		if err != nil {
			return err
		}
		wss = ids
	}
	var boardIDs []uuid.UUID
	for _, ws := range wss {
		m, err := perm.FromContext(r.Context()).Member(r.Context(), ws, me)
		if err != nil {
			continue
		}
		vis, err := VisibleBoards(r.Context(), s.db.Q, ws, m)
		if err != nil {
			return err
		}
		boardIDs = append(boardIDs, keys(vis)...)
	}
	out := &v1.MyTasksResponse{}
	if len(boardIDs) == 0 {
		httpx.Write(w, http.StatusOK, out)
		return nil
	}
	var a Args
	where := []string{"t.board_id = ANY(" + a.Add(boardIDs) + "::uuid[])", "t.archived_at IS NULL"}
	meArg := a.Add(me)
	switch qs.Get("scope") {
	case "", "assigned":
		where = append(where, "EXISTS (SELECT 1 FROM task_assignees x WHERE x.task_id = t.id AND x.user_id = "+meArg+")")
	case "lead":
		where = append(where, "EXISTS (SELECT 1 FROM task_assignees x WHERE x.task_id = t.id AND x.user_id = "+meArg+" AND x.is_lead)")
	case "created":
		where = append(where, "t.created_by = "+meArg)
	case "subscribed":
		where = append(where, "EXISTS (SELECT 1 FROM task_subscribers x WHERE x.task_id = t.id AND x.user_id = "+meArg+" AND NOT x.muted)")
	default:
		return httpx.BadRequest("scope must be assigned, lead, created or subscribed")
	}
	if qs.Get("open") == "1" {
		where = append(where, "t.status_id IN (SELECT st.id FROM board_statuses st WHERE st.type NOT IN ('completed', 'cancelled'))")
	}
	// Cursor: "<updated_at RFC 3339 nano>_<id>" of the last task of the previous page.
	if c := qs.Get("cursor"); c != "" {
		ts, id, ok := strings.Cut(c, "_")
		t, err1 := time.Parse(time.RFC3339Nano, ts)
		tid, err2 := uuid.Parse(id)
		if !ok || err1 != nil || err2 != nil {
			return httpx.BadRequest("invalid cursor")
		}
		where = append(where, "(t.updated_at, t.id) < ("+a.Add(t)+", "+a.Add(tid)+")")
	}
	rows, err := queryTasks(r.Context(), s.db.Pool, "WHERE "+strings.Join(where, " AND ")+
		" ORDER BY t.updated_at DESC, t.id DESC LIMIT "+strconv.Itoa(MyTasksPage+1), a.Values()...)
	if err != nil {
		return err
	}
	if len(rows) > MyTasksPage {
		rows = rows[:MyTasksPage]
		last := rows[len(rows)-1]
		out.NextCursor = last.UpdatedAt.UTC().Format(time.RFC3339Nano) + "_" + last.ID.String()
	}
	if out.Tasks, err = tasksProto(r.Context(), s.db.Q, rows, me); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// search: GET /api/workspaces/{id}/tasks/search?q=&limit= — ⌘K over the boards the caller sees.
func (s *Service) search(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	m, err := member(r, wsID)
	if err != nil {
		return err
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if n := utf8.RuneCountInString(q); n < 1 || n > maxTextQuery {
		return httpx.Validation("q", "q must be 1..200 characters")
	}
	if err := take(r, s.SearchLimit); err != nil {
		return err
	}
	limit := DefaultSearchSize
	if l := r.URL.Query().Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > MaxSearchSize {
			return httpx.BadRequest("limit must be 1..50")
		}
		limit = n
	}
	vis, err := VisibleBoards(r.Context(), s.db.Q, wsID, m)
	if err != nil {
		return err
	}
	out := &v1.SearchTasksResponse{}
	if len(vis) == 0 {
		httpx.Write(w, http.StatusOK, out)
		return nil
	}
	rows, err := searchTasks(r.Context(), s.db.Pool, keys(vis), q, limit)
	if err != nil {
		return err
	}
	if out.Tasks, err = tasksProto(r.Context(), s.db.Q, rows, uid(r)); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// searchTasks finds live tasks of the boards by key and words; exact key matches first, then
// by relevance and recency.
func searchTasks(ctx context.Context, dbtx sqlc.DBTX, boards []uuid.UUID, q string, limit int) ([]taskRow, error) {
	var a Args
	cond := TextCondition(q, &a)
	tsq := a.Add(q)
	key, n, isKey := ParseKey(q)
	order := "ts_rank(" + SearchVector + ", plainto_tsquery('simple', " + tsq + ")) DESC, t.updated_at DESC"
	if isKey {
		order = "(b.key = " + a.Add(key) + " AND t.number = " + a.Add(n) + ") DESC, " + order
	}
	return queryTasks(ctx, dbtx, "WHERE t.board_id = ANY("+a.Add(boards)+"::uuid[]) AND t.archived_at IS NULL AND "+cond+
		" ORDER BY "+order+" LIMIT "+strconv.Itoa(limit), a.Values()...)
}
