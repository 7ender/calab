package messages

import (
	"context"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
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
	m, err := db.GuardValue(ctx, s.h.db, func(guarded *sqlc.Queries) (sqlc.Message, error) {
		return guarded.InsertSystemMessage(ctx, sqlc.InsertSystemMessageParams{RoomID: roomID, AuthorID: author, Payload: raw})
	})
	if err != nil {
		return uuid.Nil, err
	}
	return m.ID, s.Created(ctx, workspaceID, m)
}

// PostDM writes a system message into a DM (e.g. a call card, ADR-0034) and publishes
// MESSAGE_CREATE to both participants' user channels, as for any DM message. readers get their
// read marker moved onto it in the same transaction (the author, and for most call outcomes
// the peer too); READ_STATE_UPDATE follows for each of them.
func (s *System) PostDM(ctx context.Context, roomID, author uuid.UUID, members, readers []uuid.UUID, payload *v1.SystemMessage) (sqlc.Message, error) {
	raw, err := protojson.Marshal(payload)
	if err != nil {
		return sqlc.Message{}, err
	}
	var m sqlc.Message
	err = s.h.db.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		if m, err = q.InsertSystemMessage(ctx, sqlc.InsertSystemMessageParams{RoomID: roomID, AuthorID: author, Payload: raw}); err != nil {
			return err
		}
		for _, u := range readers {
			if _, err := q.UpsertReadState(ctx, sqlc.UpsertReadStateParams{UserID: u, RoomID: roomID, LastReadMessageID: m.ID}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return m, err
	}
	out, err := s.h.details(ctx, []sqlc.Message{m}, uuid.Nil)
	if err != nil {
		return m, err
	}
	rooms.Publish(ctx, s.h.events, perm.RoomAccess{DM: true, Members: members}, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{
		MessageCreate: &v1.MessageCreate{Message: out[0]},
	}})
	for _, u := range readers {
		s.h.events.User(ctx, u, &v1.DispatchEvent{Event: &v1.DispatchEvent_ReadStateUpdate{
			ReadStateUpdate: &v1.ReadStateUpdate{ReadState: &v1.ReadState{RoomId: roomID.String(), LastReadMessageId: m.ID.String()}},
		}})
	}
	return m, nil
}

// Created publishes MESSAGE_CREATE for a system message inserted by the caller (e.g. in its
// own transaction, after the commit).
func (s *System) Created(ctx context.Context, workspaceID uuid.UUID, m sqlc.Message) error {
	out, err := s.h.details(ctx, []sqlc.Message{m}, uuid.Nil)
	if err != nil {
		return err
	}
	s.h.events.Workspace(ctx, workspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{
		MessageCreate: &v1.MessageCreate{WorkspaceId: workspaceID.String(), Message: out[0]},
	}})
	return nil
}

// Update replaces the payload of a system message and publishes MESSAGE_UPDATE. A deleted
// message stays deleted (no error). Its live forwarded copies (ADR-0033 §4) follow it, each
// with MESSAGE_UPDATE to its own room — also when the original itself was deleted.
func (s *System) Update(ctx context.Context, workspaceID, messageID uuid.UUID, payload *v1.SystemMessage) error {
	raw, err := protojson.Marshal(payload)
	if err != nil {
		return err
	}
	m, err := db.GuardValue(ctx, s.h.db, func(guarded *sqlc.Queries) (sqlc.Message, error) {
		return guarded.UpdateSystemMessage(ctx, sqlc.UpdateSystemMessageParams{ID: messageID, Payload: raw})
	})
	switch {
	case db.IsNotFound(err):
	case err != nil:
		return err
	default:
		if err := s.publishUpdate(ctx, perm.RoomAccess{WorkspaceID: workspaceID}, m); err != nil {
			return err
		}
	}
	copies, err := db.GuardValue(ctx, s.h.db, func(guarded *sqlc.Queries) ([]sqlc.Message, error) {
		return guarded.UpdateForwardedSystemMessages(ctx, sqlc.UpdateForwardedSystemMessagesParams{ForwardedFrom: &messageID, Payload: raw})
	})
	if err != nil {
		return err
	}
	for _, c := range copies {
		aud, err := s.h.db.Q.RoomAudience(ctx, c.RoomID)
		if db.IsNotFound(err) {
			continue
		}
		if err != nil {
			return err
		}
		acc := perm.RoomAccess{DM: aud.Dm, Members: aud.DmMembers}
		if aud.WorkspaceID != nil {
			acc.WorkspaceID = *aud.WorkspaceID
		}
		if err := s.publishUpdate(ctx, acc, c); err != nil {
			return err
		}
	}
	return nil
}

func (s *System) publishUpdate(ctx context.Context, acc perm.RoomAccess, m sqlc.Message) error {
	out, err := s.h.details(ctx, []sqlc.Message{m}, uuid.Nil)
	if err != nil {
		return err
	}
	rooms.Publish(ctx, s.h.events, acc, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageUpdate{
		MessageUpdate: &v1.MessageUpdate{WorkspaceId: rooms.WorkspaceIDString(acc), Message: forEvent(out[0])},
	}})
	return nil
}
