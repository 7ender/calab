package messages

import (
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/rooms"
)

// Search limits.
const (
	SearchDefaultLimit = 25
	SearchMaxLimit     = 50
	searchMaxQuery     = 200
)

// searchParams parses q, before and limit (≤ 50) for full-text search.
func searchParams(r *http.Request) (q string, before *uuid.UUID, limit int32, err error) {
	v := r.URL.Query()
	q = strings.TrimSpace(v.Get("q"))
	if q == "" || utf8.RuneCountInString(q) > searchMaxQuery {
		return "", nil, 0, httpx.Validation("q", "search query must be 1..200 characters")
	}
	limit = SearchDefaultLimit
	if s := v.Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > SearchMaxLimit {
			return "", nil, 0, httpx.BadRequest("limit must be 1..50")
		}
		limit = int32(n) //nolint:gosec // bounded
	}
	if s := v.Get("before"); s != "" {
		id, err := uuid.Parse(s)
		if err != nil {
			return "", nil, 0, httpx.BadRequest("before must be a message id")
		}
		before = &id
	}
	return q, before, limit, nil
}

func (h *Handlers) search(w http.ResponseWriter, r *http.Request, roomIDs []uuid.UUID, author *uuid.UUID) error {
	q, before, limit, err := searchParams(r)
	if err != nil {
		return err
	}
	out := &v1.ListMessagesResponse{Messages: []*v1.Message{}}
	if len(roomIDs) > 0 {
		ms, err := h.db.Q.SearchMessages(r.Context(), sqlc.SearchMessagesParams{
			RoomIds: roomIDs, Q: q, Before: before, AuthorID: author, Lim: limit + 1,
		})
		if err != nil {
			return err
		}
		out.HasMore = len(ms) > int(limit)
		if out.HasMore {
			ms = ms[:limit]
		}
		if out.Messages, err = h.withDetails(r, ms); err != nil {
			return err
		}
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// searchWorkspace: GET /api/workspaces/{id}/messages/search?q=&room_id=&author_id=&before=&limit=
// over all rooms of the workspace the caller can view.
func (h *Handlers) searchWorkspace(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	role, err := rooms.WorkspaceRole(r, wsID) // 404 for non-members
	if err != nil {
		return err
	}
	ws, err := h.db.Q.GetWorkspace(r.Context(), wsID)
	if err != nil {
		return err
	}
	ids, err := rooms.VisibleIDs(r.Context(), h.db.Q, ws, uid(r), role)
	if err != nil {
		return err
	}
	v := r.URL.Query()
	if s := v.Get("room_id"); s != "" {
		rid, err := uuid.Parse(s)
		if err != nil {
			return httpx.BadRequest("room_id must be a room id")
		}
		found := false
		for _, id := range ids {
			found = found || id == rid
		}
		if !found {
			return httpx.NotFound("room")
		}
		ids = []uuid.UUID{rid}
	}
	var author *uuid.UUID
	if s := v.Get("author_id"); s != "" {
		a, err := uuid.Parse(s)
		if err != nil {
			return httpx.BadRequest("author_id must be a user id")
		}
		author = &a
	}
	return h.search(w, r, ids, author)
}
