// Package messages implements room chat: history, idempotent send, edit, delete, read state.
package messages

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rooms"
)

// Limits (docs/04, docs/05).
const (
	MaxContent     = 4000
	MaxAttachments = 20
	MaxNonce       = 64
	DefaultLimit   = 50
	MaxLimit       = 100
)

// Handlers serves message endpoints.
type Handlers struct {
	db      *db.DB
	events  events.Publisher
	limiter *redisx.RateLimiter // per (room, user): burst 5, 1/s
}

// NewHandlers creates the message handlers.
func NewHandlers(d *db.DB, ev events.Publisher, limiter *redisx.RateLimiter) *Handlers {
	return &Handlers{db: d, events: ev, limiter: limiter}
}

// Routes registers authenticated routes; wrap must apply auth + perm resolver.
func (h *Handlers) Routes(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/rooms/{id}/messages", wrap(httpx.HandlerFunc(h.list)))
	mux.Handle("POST /api/rooms/{id}/messages", wrap(httpx.HandlerFunc(h.create)))
	mux.Handle("PATCH /api/messages/{id}", wrap(httpx.HandlerFunc(h.update)))
	mux.Handle("DELETE /api/messages/{id}", wrap(httpx.HandlerFunc(h.delete)))
	mux.Handle("PUT /api/rooms/{id}/read", wrap(httpx.HandlerFunc(h.read)))
	mux.Handle("GET /api/workspaces/{id}/messages/search", wrap(httpx.HandlerFunc(h.searchWorkspace)))
	mux.Handle("PUT /api/messages/{id}/reactions/{emoji}", wrap(httpx.HandlerFunc(h.addReaction)))
	mux.Handle("DELETE /api/messages/{id}/reactions/{emoji}", wrap(httpx.HandlerFunc(h.removeReaction)))
	mux.Handle("PUT /api/messages/{id}/pin", wrap(httpx.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error { return h.setPin(w, r, true) })))
	mux.Handle("DELETE /api/messages/{id}/pin", wrap(httpx.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error { return h.setPin(w, r, false) })))
	mux.Handle("GET /api/rooms/{id}/pins", wrap(httpx.HandlerFunc(h.listPins)))
	mux.Handle("GET /api/me/mentions", wrap(httpx.HandlerFunc(h.listMentions)))
	mux.Handle("PUT /api/messages/{id}/embeds-hidden", wrap(httpx.HandlerFunc(h.setEmbedsHidden)))
}

func uid(r *http.Request) uuid.UUID { return auth.MustFromContext(r.Context()).UserID }

// withAttachments converts messages, loading all attachments in one query.
func withAttachments(ctx context.Context, q *sqlc.Queries, ms []sqlc.Message) ([]*v1.Message, error) {
	ids := make([]uuid.UUID, len(ms))
	for i, m := range ms {
		ids[i] = m.ID
	}
	files := map[uuid.UUID][]sqlc.File{}
	if len(ids) > 0 {
		rows, err := q.ListAttachments(ctx, ids)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			files[r.MessageID] = append(files[r.MessageID], r.File)
		}
	}
	out := make([]*v1.Message, len(ms))
	for i, m := range ms {
		out[i] = pbconv.Message(m, files[m.ID])
	}
	return out, nil
}

// Page parses ?before=&after=&limit=. A malformed cursor is a 400.
type Page struct {
	Before, After *uuid.UUID
	Limit         int32
}

// ParsePage validates pagination query parameters.
func ParsePage(r *http.Request) (Page, error) {
	q := r.URL.Query()
	p := Page{Limit: DefaultLimit}
	if s := q.Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > MaxLimit {
			return p, httpx.BadRequest("limit must be 1..100")
		}
		p.Limit = int32(n) //nolint:gosec // bounded above
	}
	for name, dst := range map[string]**uuid.UUID{"before": &p.Before, "after": &p.After} {
		if s := q.Get(name); s != "" {
			id, err := uuid.Parse(s)
			if err != nil {
				return p, httpx.BadRequest(name + " must be a message id")
			}
			*dst = &id
		}
	}
	if p.Before != nil && p.After != nil {
		return p, httpx.BadRequest("use either before or after")
	}
	return p, nil
}

func (h *Handlers) list(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	if _, err := rooms.Access(r, roomID); err != nil {
		return err
	}
	if r.URL.Query().Has("q") {
		return h.search(w, r, []uuid.UUID{roomID}, nil)
	}
	p, err := ParsePage(r)
	if err != nil {
		return err
	}
	var ms []sqlc.Message
	if p.After != nil {
		ms, err = h.db.Q.ListMessagesAfter(r.Context(), sqlc.ListMessagesAfterParams{RoomID: roomID, After: *p.After, Lim: p.Limit + 1})
	} else {
		ms, err = h.db.Q.ListMessagesBefore(r.Context(), sqlc.ListMessagesBeforeParams{RoomID: roomID, Before: p.Before, Lim: p.Limit + 1})
	}
	if err != nil {
		return err
	}
	more := len(ms) > int(p.Limit)
	if more {
		ms = ms[:p.Limit]
	}
	out, err := h.withDetails(r, ms)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListMessagesResponse{Messages: out, HasMore: more})
	return nil
}

// ValidateContent checks message text; empty text is allowed only with attachments.
func ValidateContent(content string, attachments int) error {
	if utf8.RuneCountInString(content) > MaxContent {
		return httpx.Validation("content", "content must be at most 4000 characters")
	}
	if strings.TrimSpace(content) == "" && attachments == 0 {
		return httpx.Validation("content", "message is empty")
	}
	return nil
}

func parseAttachments(ids []string) ([]uuid.UUID, error) {
	if len(ids) > MaxAttachments {
		return nil, httpx.Validation("attachmentIds", "at most 20 attachments")
	}
	out := make([]uuid.UUID, 0, len(ids))
	seen := map[uuid.UUID]bool{}
	for _, s := range ids {
		id, err := uuid.Parse(s)
		if err != nil || seen[id] {
			return nil, httpx.Validation("attachmentIds", "invalid or duplicate file id")
		}
		seen[id] = true
		out = append(out, id)
	}
	return out, nil
}

// sameScope reports whether a file may be attached in the room: a workspace room takes
// uploads to its workspace, a DM takes user-scoped uploads (POST /api/dms/{id}/files).
func sameScope(fileWS *uuid.UUID, acc perm.RoomAccess) bool {
	if acc.DM {
		return fileWS == nil
	}
	return fileWS != nil && *fileWS == acc.WorkspaceID
}

func (h *Handlers) existing(ctx context.Context, roomID, author uuid.UUID, nonce string) (*v1.Message, error) {
	m, err := h.db.Q.GetMessageByNonce(ctx, sqlc.GetMessageByNonceParams{AuthorID: author, Nonce: &nonce})
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if m.RoomID != roomID || m.DeletedAt != nil {
		return nil, httpx.Conflict("nonce already used")
	}
	out, err := withAttachments(ctx, h.db.Q, []sqlc.Message{m})
	if err != nil {
		return nil, err
	}
	return out[0], nil
}

func (h *Handlers) create(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.SendMessages) {
		return httpx.Forbidden("SEND_MESSAGES required")
	}
	var req v1.CreateMessageRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	fileIDs, err := parseAttachments(req.GetAttachmentIds())
	if err != nil {
		return err
	}
	if err := ValidateContent(req.GetContent(), len(fileIDs)); err != nil {
		return err
	}
	if len(fileIDs) > 0 && !acc.Bits.Has(perm.AttachFiles) {
		return httpx.Forbidden("ATTACH_FILES required")
	}
	var nonce *string
	if n := req.GetNonce(); n != "" {
		if len(n) > MaxNonce {
			return httpx.Validation("nonce", "nonce must be at most 64 bytes")
		}
		nonce = &n
		// A retry must not be rate limited or create a duplicate.
		if m, err := h.existing(r.Context(), roomID, uid(r), n); err != nil || m != nil {
			if err == nil {
				httpx.Write(w, http.StatusOK, &v1.CreateMessageResponse{Message: m})
			}
			return err
		}
	}
	if err := h.limiter.Take(r.Context(), roomID.String()+":"+uid(r).String()); err != nil {
		return err
	}
	var replyTo *uuid.UUID
	if s := req.GetReplyToId(); s != "" {
		id, err := uuid.Parse(s)
		if err != nil {
			return httpx.Validation("replyToId", "invalid message id")
		}
		ref, err := h.db.Q.GetMessage(r.Context(), id)
		if db.IsNotFound(err) || (err == nil && ref.RoomID != roomID) {
			return httpx.Validation("replyToId", "message not found in this room")
		}
		if err != nil {
			return err
		}
		replyTo = &id
	}

	var (
		msg   sqlc.Message
		files []sqlc.File
		dup   bool
	)
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if len(fileIDs) > 0 {
			rows, err := q.GetFilesWithUsage(r.Context(), fileIDs)
			if err != nil {
				return err
			}
			byID := map[uuid.UUID]sqlc.GetFilesWithUsageRow{}
			for _, f := range rows {
				byID[f.ID] = f
			}
			for _, id := range fileIDs {
				f, ok := byID[id]
				if !ok || f.UploaderID != uid(r) || !sameScope(f.WorkspaceID, acc) || f.Attached {
					return httpx.Validation("attachmentIds", "file "+id.String()+" is not an unattached upload of yours in this workspace")
				}
				files = append(files, sqlc.File{
					ID: f.ID, WorkspaceID: f.WorkspaceID, UploaderID: f.UploaderID, Key: f.Key, ThumbnailKey: f.ThumbnailKey,
					Name: f.Name, Mime: f.Mime, Size: f.Size, Width: f.Width, Height: f.Height, Sha256: f.Sha256, CreatedAt: f.CreatedAt,
				})
			}
		}
		var err error
		msg, err = q.InsertMessage(r.Context(), sqlc.InsertMessageParams{
			RoomID: roomID, AuthorID: uid(r), Content: req.GetContent(), ReplyToID: replyTo, Nonce: nonce,
		})
		if db.IsNotFound(err) { // concurrent retry with the same nonce won the race
			dup = true
			return nil
		}
		if err != nil {
			return err
		}
		for i, f := range files {
			if err := q.InsertAttachment(r.Context(), sqlc.InsertAttachmentParams{MessageID: msg.ID, FileID: f.ID, Position: int16(i)}); err != nil { //nolint:gosec // ≤ 20
				if db.UniqueViolation(err) != "" {
					return httpx.Conflict("file is already attached to another message")
				}
				return err
			}
		}
		if err := saveMentions(r.Context(), q, msg, acc, false); err != nil {
			return err
		}
		_, err = q.UpsertReadState(r.Context(), sqlc.UpsertReadStateParams{UserID: uid(r), RoomID: roomID, LastReadMessageID: msg.ID})
		return err
	})
	if err != nil {
		return err
	}
	if dup {
		m, err := h.existing(r.Context(), roomID, uid(r), *nonce)
		if err != nil {
			return err
		}
		httpx.Write(w, http.StatusOK, &v1.CreateMessageResponse{Message: m})
		return nil
	}
	pb := pbconv.Message(msg, files)
	rooms.Publish(r.Context(), h.events, acc, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{
		MessageCreate: &v1.MessageCreate{WorkspaceId: rooms.WorkspaceIDString(acc), Message: pb},
	}})
	h.events.User(r.Context(), uid(r), &v1.DispatchEvent{Event: &v1.DispatchEvent_ReadStateUpdate{
		ReadStateUpdate: &v1.ReadStateUpdate{ReadState: &v1.ReadState{RoomId: roomID.String(), LastReadMessageId: msg.ID.String()}},
	}})
	httpx.Write(w, http.StatusCreated, &v1.CreateMessageResponse{Message: pb})
	return nil
}

// load returns a live message and the caller's access to its room (404 if hidden).
func (h *Handlers) load(r *http.Request) (sqlc.Message, perm.RoomAccess, error) {
	id, err := httpx.PathUUID(r, "id", "message")
	if err != nil {
		return sqlc.Message{}, perm.RoomAccess{}, err
	}
	m, err := h.db.Q.GetMessage(r.Context(), id)
	if db.IsNotFound(err) {
		return m, perm.RoomAccess{}, httpx.NotFound("message")
	}
	if err != nil {
		return m, perm.RoomAccess{}, err
	}
	acc, err := rooms.Access(r, m.RoomID)
	if err != nil {
		return m, acc, httpx.NotFound("message")
	}
	return m, acc, nil
}

func (h *Handlers) update(w http.ResponseWriter, r *http.Request) error {
	m, acc, err := h.load(r)
	if err != nil {
		return err
	}
	if m.AuthorID != uid(r) {
		return httpx.Forbidden("only the author can edit a message")
	}
	var req v1.UpdateMessageRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	// Length first (the DB CHECK would otherwise surface as a 500); "empty only with
	// attachments" needs the attachment count and is checked in the transaction.
	if utf8.RuneCountInString(req.GetContent()) > MaxContent {
		return httpx.Validation("content", "content must be at most 4000 characters")
	}
	var out []*v1.Message
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		upd, err := q.UpdateMessageContent(r.Context(), sqlc.UpdateMessageContentParams{ID: m.ID, Content: req.GetContent()})
		if db.IsNotFound(err) {
			return httpx.NotFound("message")
		}
		if err != nil {
			return err
		}
		if out, err = withAttachments(r.Context(), q, []sqlc.Message{upd}); err != nil {
			return err
		}
		if err := saveMentions(r.Context(), q, upd, acc, true); err != nil {
			return err
		}
		return ValidateContent(req.GetContent(), len(out[0].GetAttachments())) // rolls back if empty
	})
	if err != nil {
		return err
	}
	full, err := h.details(r.Context(), []sqlc.Message{{ID: parseMsgID(out[0])}}, uid(r))
	if err != nil {
		return err
	}
	out[0].Reactions = full[0].GetReactions()
	rooms.Publish(r.Context(), h.events, acc, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageUpdate{
		MessageUpdate: &v1.MessageUpdate{WorkspaceId: rooms.WorkspaceIDString(acc), Message: forEvent(out[0])},
	}})
	httpx.Write(w, http.StatusOK, &v1.UpdateMessageResponse{Message: out[0]})
	return nil
}

func (h *Handlers) delete(w http.ResponseWriter, r *http.Request) error {
	m, acc, err := h.load(r)
	if err != nil {
		return err
	}
	if m.AuthorID != uid(r) && !acc.Bits.Has(perm.ManageMessages) {
		return httpx.Forbidden("MANAGE_MESSAGES required to delete others' messages")
	}
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		n, err := q.SoftDeleteMessage(r.Context(), m.ID)
		if err != nil {
			return err
		}
		if n == 0 {
			return httpx.NotFound("message")
		}
		if err := clearMentions(r.Context(), q, m.ID); err != nil {
			return err
		}
		// Detached files become orphans and are removed by the cleanup job.
		return q.DetachMessageFiles(r.Context(), m.ID)
	})
	if err != nil {
		return err
	}
	rooms.Publish(r.Context(), h.events, acc, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageDelete{
		MessageDelete: &v1.MessageDelete{WorkspaceId: rooms.WorkspaceIDString(acc), RoomId: m.RoomID.String(), MessageId: m.ID.String()},
	}})
	httpx.NoContent(w)
	return nil
}

func (h *Handlers) read(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	if _, err := rooms.Access(r, roomID); err != nil {
		return err
	}
	var req v1.UpdateReadStateRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	mid, err := uuid.Parse(req.GetMessageId())
	if err != nil {
		return httpx.Validation("messageId", "invalid message id")
	}
	m, err := h.db.Q.GetMessage(r.Context(), mid)
	if db.IsNotFound(err) || (err == nil && m.RoomID != roomID) {
		return httpx.Validation("messageId", "message not found in this room")
	}
	if err != nil {
		return err
	}
	rs, err := h.db.Q.UpsertReadState(r.Context(), sqlc.UpsertReadStateParams{UserID: uid(r), RoomID: roomID, LastReadMessageID: mid})
	if err != nil {
		return err
	}
	h.events.User(r.Context(), uid(r), &v1.DispatchEvent{Event: &v1.DispatchEvent_ReadStateUpdate{
		ReadStateUpdate: &v1.ReadStateUpdate{ReadState: &v1.ReadState{RoomId: roomID.String(), LastReadMessageId: rs.LastReadMessageID.String()}},
	}})
	httpx.NoContent(w)
	return nil
}

// setEmbedsHidden hides or shows the link previews of a message (author, or
// MANAGE_MESSAGES). The message is not marked edited; the room gets MESSAGE_UPDATE.
func (h *Handlers) setEmbedsHidden(w http.ResponseWriter, r *http.Request) error {
	m, acc, err := h.load(r)
	if err != nil {
		return err
	}
	if m.AuthorID != uid(r) && !acc.Bits.Has(perm.ManageMessages) {
		return httpx.Forbidden("only the author or MANAGE_MESSAGES can hide link previews")
	}
	var req v1.SetEmbedsHiddenRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	upd, err := h.db.Q.SetEmbedsHidden(r.Context(), sqlc.SetEmbedsHiddenParams{ID: m.ID, EmbedsHidden: req.GetHidden()})
	if db.IsNotFound(err) {
		return httpx.NotFound("message")
	}
	if err != nil {
		return err
	}
	out, err := h.details(r.Context(), []sqlc.Message{upd}, uid(r))
	if err != nil {
		return err
	}
	rooms.Publish(r.Context(), h.events, acc, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageUpdate{
		MessageUpdate: &v1.MessageUpdate{WorkspaceId: rooms.WorkspaceIDString(acc), Message: forEvent(out[0])},
	}})
	httpx.Write(w, http.StatusOK, &v1.UpdateMessageResponse{Message: out[0]})
	return nil
}
