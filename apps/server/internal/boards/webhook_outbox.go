package boards

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// The board webhook outbox (ADR-0058 §4): the journal entries a task mutation wrote become,
// in the same transaction, one delivery per changed task on its board, numbered by the
// board's sequence. A rolled-back change leaves no delivery; a committed one always has it.

// webhookJSON: the body encoding — protojson with the proto field names (the ADR-0058
// payload: occurred_at, task_url, is_bot…) and every field present (unset messages as null:
// "actor": null for the server's own changes).
var webhookJSON = protojson.MarshalOptions{UseProtoNames: true, EmitUnpopulated: true}

// Event types.
const (
	evTaskCreated  = "task.created"
	evTaskUpdated  = "task.updated"
	evTaskArchived = "task.archived"
	evTaskRestored = "task.restored"
	evTaskMovedOut = "task.moved_out"
	evTaskMovedIn  = "task.moved_in"
	evCommentPfx   = "task.comment."
)

// taskTx is s.tx for task mutations: after fn, in the same transaction, the journal entries
// collected in c are queued for the board webhooks; the worker is woken after the commit.
func (s *Service) taskTx(ctx context.Context, c *change, fn func(q *sqlc.Queries, tx pgx.Tx) error) error {
	queued := 0
	err := s.tx(ctx, func(q *sqlc.Queries, tx pgx.Tx) error {
		if err := fn(q, tx); err != nil {
			return err
		}
		var err error
		queued, err = s.webhookOutbox(ctx, q, tx, c.acts)
		return err
	})
	if err == nil && queued > 0 {
		s.hooks.wake()
	}
	return err
}

// webhookOutbox queues the journal entries of one transaction: one event per task (a move
// between boards: moved_out to the old board and moved_in to the new one). Returns how many
// deliveries were queued.
func (s *Service) webhookOutbox(ctx context.Context, q *sqlc.Queries, tx sqlc.DBTX, acts []sqlc.TaskActivity) (int, error) {
	if len(acts) == 0 {
		return 0, nil
	}
	var order []uuid.UUID
	byTask := map[uuid.UUID][]sqlc.TaskActivity{}
	for _, a := range acts {
		if _, ok := byTask[a.TaskID]; !ok {
			order = append(order, a.TaskID)
		}
		byTask[a.TaskID] = append(byTask[a.TaskID], a)
	}
	n := 0
	for _, id := range order {
		as := byTask[id]
		for _, e := range taskEvents(as) {
			ok, err := s.enqueueWebhook(ctx, q, tx, e.board, e.typ, as[0].ActorID, id, as, nil)
			if err != nil {
				return n, err
			}
			if ok {
				n++
			}
		}
	}
	return n, nil
}

type boardEvent struct {
	board uuid.UUID
	typ   string
}

// taskEvents: which events the journal entries of one task in one transaction make.
func taskEvents(as []sqlc.TaskActivity) []boardEvent {
	typ := evTaskUpdated
	for _, a := range as {
		switch a.Kind {
		case "moved_board":
			var before struct {
				BoardID string `json:"board_id"`
			}
			if json.Unmarshal(a.Before, &before) == nil {
				if src, err := uuid.Parse(before.BoardID); err == nil && src != a.BoardID {
					return []boardEvent{{src, evTaskMovedOut}, {a.BoardID, evTaskMovedIn}}
				}
			}
		case "created":
			typ = evTaskCreated
		case "archived":
			typ = evTaskArchived
		case "restored":
			typ = evTaskRestored
		}
	}
	return []boardEvent{{as[len(as)-1].BoardID, typ}}
}

// enqueueWebhook writes one delivery of a task event when the board has a working webhook,
// is not archived and its workspace's plan includes webhooks (else nothing: paused). q / tx
// belong to the transaction of the change. true = queued.
func (s *Service) enqueueWebhook(ctx context.Context, q *sqlc.Queries, tx sqlc.DBTX, board uuid.UUID, typ string,
	actor *uuid.UUID, taskID uuid.UUID, as []sqlc.TaskActivity, comment *v1.BoardWebhookEvent_Comment) (bool, error) {
	wh, err := q.GetBoardWebhook(ctx, board)
	if db.IsNotFound(err) {
		return false, nil // the common case: one index lookup
	}
	if err != nil || wh.DisabledAt != nil {
		return false, err
	}
	b, err := q.GetBoard(ctx, board)
	if err != nil || b.ArchivedAt != nil {
		return false, err // an archived board makes no events; its queue drains
	}
	if ok, err := s.webhooksAllowed(ctx, b.WorkspaceID); err != nil || !ok {
		return false, err // paused by the plan: nothing is queued
	}
	seq, err := q.NextBoardWebhookSeq(ctx, board)
	if db.IsNotFound(err) {
		return false, nil // disabled meanwhile
	}
	if err != nil {
		return false, err
	}
	ev, err := s.webhookEvent(ctx, q, b, typ, seq, actor)
	if err != nil {
		return false, err
	}
	t, ok, err := taskByID(ctx, tx, taskID, false)
	if err != nil || !ok {
		return false, err
	}
	pbs, err := tasksProto(ctx, q, []taskRow{t}, uuid.Nil)
	if err != nil {
		return false, err
	}
	ev.Task = pbs[0]
	if s.PublicURL != "" {
		ev.TaskUrl = strings.TrimRight(s.PublicURL, "/") + "/t/" + pbs[0].GetKey()
	}
	for _, a := range as {
		ev.Changes = append(ev.Changes, &v1.BoardWebhookEvent_Change{Field: a.Kind, Before: jsonStruct(a.Before), After: jsonStruct(a.After)})
	}
	ev.Comment = comment
	id, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	ev.Id = id.String()
	body, err := webhookJSON.Marshal(ev)
	if err != nil {
		return false, err
	}
	err = q.EnqueueBoardWebhookDelivery(ctx, sqlc.EnqueueBoardWebhookDeliveryParams{ID: id, BoardID: board, Seq: seq, EventType: typ, Payload: body})
	return err == nil, err
}

// webhookEvent: the common part of an event (no id, task or changes yet).
func (s *Service) webhookEvent(ctx context.Context, q *sqlc.Queries, b sqlc.Board, typ string, seq int64, actor *uuid.UUID) (*v1.BoardWebhookEvent, error) {
	ev := &v1.BoardWebhookEvent{
		Version: webhookVersion, Type: typ, Sequence: uint32(seq), //nolint:gosec // per board, far below 2^32
		OccurredAt: timestamppb.New(s.Now()), WorkspaceId: b.WorkspaceID.String(),
		Board: &v1.BoardWebhookEvent_BoardRef{Id: b.ID.String(), Key: b.Key, Name: b.Name},
	}
	if actor != nil {
		u, err := q.GetUser(ctx, *actor)
		if err != nil && !db.IsNotFound(err) {
			return nil, err
		}
		ev.Actor = &v1.BoardWebhookEvent_Actor{Id: actor.String(), Name: u.DisplayName, IsBot: u.IsBot}
	}
	return ev, nil
}

// TaskCommentHook queues task.comment.<kind> ("created", "updated", "deleted") of a comment
// after it committed (messages.Handlers.TaskCommentHook; created via TaskHook). The window
// between the message commit and this transaction is accepted (ADR-0058 §4). A deleted comment
// goes without its text and attachments.
func (s *Service) TaskCommentHook(ctx context.Context, acc perm.RoomAccess, kind string, msg sqlc.Message, actor uuid.UUID) {
	if !acc.Task {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	queued := false
	err := s.tx(ctx, func(q *sqlc.Queries, tx pgx.Tx) error {
		t, ok, err := taskByID(ctx, tx, acc.TaskID, false)
		if err != nil || !ok {
			return err
		}
		c := &v1.BoardWebhookEvent_Comment{Id: msg.ID.String(), AuthorId: msg.AuthorID.String(),
			CreatedAt: timestamppb.New(msg.CreatedAt), EditedAt: tsp(msg.EditedAt), Attachments: []*v1.BoardWebhookEvent_CommentAttachment{}}
		if kind != "deleted" {
			c.Text = msg.Content
			rows, err := q.ListAttachments(ctx, []uuid.UUID{msg.ID})
			if err != nil {
				return err
			}
			for _, r := range rows {
				c.Attachments = append(c.Attachments, &v1.BoardWebhookEvent_CommentAttachment{
					Name: r.File.Name, Size: uint64(max(r.File.Size, 0)), Mime: r.File.Mime}) //nolint:gosec // a size
			}
		}
		queued, err = s.enqueueWebhook(ctx, q, tx, t.BoardID, evCommentPfx+kind, &actor, t.ID, nil, c)
		return err
	})
	if err != nil {
		slog.WarnContext(ctx, "boards: comment webhook", "task", acc.TaskID, "err", err)
		return
	}
	if queued {
		s.hooks.wake()
	}
}
