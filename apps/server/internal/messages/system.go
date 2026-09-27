package messages

import (
	"context"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
)

// System posts and updates system messages (kind 'system', ADR-0025): cards the server
// writes into a workspace room's chat, e.g. a meeting recording. Clients render them from
// Message.system; the author is the user the event is about.
type System struct{ h *Handlers }

// NewSystem creates the system message writer.
func NewSystem(d *db.DB, ev events.Publisher) *System {
	return &System{h: &Handlers{db: d, events: ev}}
}

// Post writes a system message into a workspace room and publishes MESSAGE_CREATE.
func (s *System) Post(ctx context.Context, workspaceID, roomID, author uuid.UUID, payload *v1.SystemMessage) (uuid.UUID, error) {
	raw, err := protojson.Marshal(payload)
	if err != nil {
		return uuid.Nil, err
	}
	m, err := s.h.db.Q.InsertSystemMessage(ctx, sqlc.InsertSystemMessageParams{RoomID: roomID, AuthorID: author, Payload: raw})
	if err != nil {
		return uuid.Nil, err
	}
	out, err := s.h.details(ctx, []sqlc.Message{m}, uuid.Nil)
	if err != nil {
		return m.ID, err
	}
	s.h.events.Workspace(ctx, workspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{
		MessageCreate: &v1.MessageCreate{WorkspaceId: workspaceID.String(), Message: out[0]},
	}})
	return m.ID, nil
}

// Update replaces the payload of a system message and publishes MESSAGE_UPDATE. A deleted
// message stays deleted (no error).
func (s *System) Update(ctx context.Context, workspaceID, messageID uuid.UUID, payload *v1.SystemMessage) error {
	raw, err := protojson.Marshal(payload)
	if err != nil {
		return err
	}
	m, err := s.h.db.Q.UpdateSystemMessage(ctx, sqlc.UpdateSystemMessageParams{ID: messageID, Payload: raw})
	if db.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	out, err := s.h.details(ctx, []sqlc.Message{m}, uuid.Nil)
	if err != nil {
		return err
	}
	s.h.events.Workspace(ctx, workspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageUpdate{
		MessageUpdate: &v1.MessageUpdate{WorkspaceId: workspaceID.String(), Message: forEvent(out[0])},
	}})
	return nil
}
