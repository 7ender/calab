package messages

import (
	"context"
	"net/http"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

// Limits for reactions and pins.
const (
	MaxEmojisPerMessage = 20
	MaxPinsPerRoom      = 50
)

// ValidEmoji accepts one emoji sequence: 1..64 bytes, ≤ 16 code points, at least one
// non-ASCII code point, no spaces or control characters. (Emoji segmentation is left to
// the client; this only keeps arbitrary text out.)
func ValidEmoji(s string) bool {
	if len(s) == 0 || len(s) > 64 || !utf8.ValidString(s) || utf8.RuneCountInString(s) > 16 {
		return false
	}
	nonASCII := false
	for _, r := range s {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
		nonASCII = nonASCII || r > unicode.MaxASCII
	}
	return nonASCII
}

// withDetails converts messages for REST responses: attachments and reactions (with `me`
// relative to the caller) are loaded in one query each.
func (h *Handlers) withDetails(r *http.Request, ms []sqlc.Message) ([]*v1.Message, error) {
	return h.details(r.Context(), ms, uid(r))
}

// details loads attachments and reactions; viewer uuid.Nil = for events (me always false).
func (h *Handlers) details(ctx context.Context, ms []sqlc.Message, viewer uuid.UUID) ([]*v1.Message, error) {
	out, err := withAttachments(ctx, h.db.Q, ms)
	if err != nil || len(ms) == 0 {
		return out, err
	}
	ids := make([]uuid.UUID, len(ms))
	for i, m := range ms {
		ids[i] = m.ID
	}
	rows, err := h.db.Q.ListReactions(ctx, sqlc.ListReactionsParams{Viewer: viewer, Ids: ids})
	if err != nil {
		return nil, err
	}
	byMsg := map[string][]*v1.Reaction{}
	for _, row := range rows {
		k := row.MessageID.String()
		byMsg[k] = append(byMsg[k], &v1.Reaction{Emoji: row.Emoji, Count: uint32(max(row.Count, 0)), Me: row.Me})
	}
	for _, m := range out {
		m.Reactions = byMsg[m.GetId()]
	}
	return out, nil
}

func (h *Handlers) reaction(r *http.Request) (sqlc.Message, perm.RoomAccess, string, error) {
	m, acc, err := h.load(r)
	if err != nil {
		return m, acc, "", err
	}
	emoji := r.PathValue("emoji")
	if !ValidEmoji(emoji) {
		return m, acc, "", httpx.Validation("emoji", "not an emoji")
	}
	return m, acc, emoji, nil
}

func reactionEvent(add bool, acc perm.RoomAccess, m sqlc.Message, user uuid.UUID, emoji string) *v1.DispatchEvent {
	w, room, msg, u := acc.WorkspaceID.String(), m.RoomID.String(), m.ID.String(), user.String()
	if add {
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageReactionAdd{MessageReactionAdd: &v1.MessageReactionAdd{
			WorkspaceId: w, RoomId: room, MessageId: msg, UserId: u, Emoji: emoji}}}
	}
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageReactionRemove{MessageReactionRemove: &v1.MessageReactionRemove{
		WorkspaceId: w, RoomId: room, MessageId: msg, UserId: u, Emoji: emoji}}}
}

// addReaction: PUT /api/messages/{id}/reactions/{emoji} (SEND_MESSAGES). Idempotent, 204.
func (h *Handlers) addReaction(w http.ResponseWriter, r *http.Request) error {
	m, acc, emoji, err := h.reaction(r)
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.SendMessages) {
		return httpx.Forbidden("SEND_MESSAGES required")
	}
	st, err := h.db.Q.ReactionEmojiStats(r.Context(), sqlc.ReactionEmojiStatsParams{MessageID: m.ID, Emoji: emoji})
	if err != nil {
		return err
	}
	if !st.HasEmoji && st.DistinctEmojis >= MaxEmojisPerMessage {
		return httpx.Validation("emoji", "too many different reactions on this message")
	}
	n, err := h.db.Q.AddReaction(r.Context(), sqlc.AddReactionParams{MessageID: m.ID, UserID: uid(r), Emoji: emoji})
	if db.IsForeignKeyViolation(err) {
		return httpx.NotFound("message")
	}
	if err != nil {
		return err
	}
	if n > 0 {
		h.events.Workspace(r.Context(), acc.WorkspaceID, reactionEvent(true, acc, m, uid(r), emoji))
	}
	httpx.NoContent(w)
	return nil
}

// removeReaction: DELETE /api/messages/{id}/reactions/{emoji} — the caller's own reaction.
func (h *Handlers) removeReaction(w http.ResponseWriter, r *http.Request) error {
	m, acc, emoji, err := h.reaction(r)
	if err != nil {
		return err
	}
	n, err := h.db.Q.RemoveReaction(r.Context(), sqlc.RemoveReactionParams{MessageID: m.ID, UserID: uid(r), Emoji: emoji})
	if err != nil {
		return err
	}
	if n > 0 {
		h.events.Workspace(r.Context(), acc.WorkspaceID, reactionEvent(false, acc, m, uid(r), emoji))
	}
	httpx.NoContent(w)
	return nil
}

// ---- pins ----

func (h *Handlers) setPin(w http.ResponseWriter, r *http.Request, pin bool) error {
	m, acc, err := h.load(r)
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.ManageMessages) {
		return httpx.Forbidden("MANAGE_MESSAGES required")
	}
	var upd sqlc.Message
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		if pin {
			n, err := q.CountPins(r.Context(), m.RoomID)
			if err != nil {
				return err
			}
			if n >= MaxPinsPerRoom {
				return httpx.Validation("id", "a room can have at most 50 pinned messages")
			}
			upd, err = q.PinMessage(r.Context(), sqlc.PinMessageParams{ID: m.ID, PinnedBy: ptr(uid(r))})
			return err
		}
		upd, err = q.UnpinMessage(r.Context(), m.ID)
		return err
	})
	if db.IsNotFound(err) { // already in the requested state
		httpx.NoContent(w)
		return nil
	}
	if err != nil {
		return err
	}
	out, err := h.details(r.Context(), []sqlc.Message{upd}, uuid.Nil)
	if err != nil {
		return err
	}
	h.events.Workspace(r.Context(), acc.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageUpdate{
		MessageUpdate: &v1.MessageUpdate{WorkspaceId: acc.WorkspaceID.String(), Message: out[0]},
	}})
	httpx.NoContent(w)
	return nil
}

func ptr[T any](v T) *T { return &v }

func (h *Handlers) listPins(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	if _, err := rooms.Access(r, roomID); err != nil {
		return err
	}
	ms, err := h.db.Q.ListPins(r.Context(), roomID)
	if err != nil {
		return err
	}
	out, err := h.withDetails(r, ms)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListMessagesResponse{Messages: out})
	return nil
}

func parseMsgID(m *v1.Message) uuid.UUID {
	id, _ := uuid.Parse(m.GetId())
	return id
}

// forEvent returns a copy of m for broadcasting: reaction counts stay, `me` is cleared
// (it is relative to the REST caller).
func forEvent(m *v1.Message) *v1.Message {
	c := proto.Clone(m).(*v1.Message)
	for _, r := range c.GetReactions() {
		r.Me = false
	}
	return c
}
