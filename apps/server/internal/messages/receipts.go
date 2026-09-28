package messages

import (
	"bytes"
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/perm"
)

// ReceiptWindow bounds READ_RECEIPT of a workspace room to one event per window (docs/09 #92).
const ReceiptWindow = 3 * time.Second

// Receipts publishes read receipts (READ_RECEIPT, docs/09 #92) after a read marker moved: in
// a DM to the peer at once, in a workspace room — when the furthest marker of the others
// advances for some member — at most once per room per window (leading edge now, one
// trailing event at the end of the window with the markers as they are then).
type Receipts struct {
	db     *db.DB
	events events.Publisher
	redis  rueidis.Client
	window time.Duration
}

// NewReceipts creates the read receipt publisher.
func NewReceipts(d *db.DB, ev events.Publisher, r rueidis.Client) *Receipts {
	return &Receipts{db: d, events: ev, redis: r, window: ReceiptWindow}
}

func receiptKey(room uuid.UUID) string { return "rr:" + room.String() }

// afterRead handles a read marker of reader (a person, not a bot) that moved to mark.
func (rc *Receipts) afterRead(ctx context.Context, acc perm.RoomAccess, room, reader, mark uuid.UUID) {
	ctx, done := events.Detached(ctx, time.Second)
	defer done()
	if acc.DM {
		for _, u := range acc.Members {
			if u != reader {
				rc.events.User(ctx, u, receipt(room, mark, uuid.Nil))
			}
		}
		return
	}
	top, err := rc.db.Q.TopRoomReads(ctx, room)
	if err != nil {
		slog.WarnContext(ctx, "read receipt: top reads", "room", room, "err", err)
		return
	}
	// A member's value is the furthest marker of everyone else; the lowest of them belongs to
	// the furthest reader other than reader (the second furthest of the others). Nobody learns
	// anything new unless mark passes it.
	var others []sqlc.TopRoomReadsRow
	for _, t := range top {
		if t.UserID != reader {
			others = append(others, t)
		}
	}
	if len(others) >= 2 && bytes.Compare(mark[:], others[1].LastReadMessageID[:]) <= 0 {
		return
	}
	key := receiptKey(room)
	err = rc.redis.Do(ctx, rc.redis.B().Set().Key(key).Value("1").Nx().Px(rc.window).Build()).Error()
	if err == nil {
		rc.publish(ctx, acc.WorkspaceID, room, top)
		return
	}
	if !rueidis.IsRedisNil(err) {
		slog.WarnContext(ctx, "read receipt: throttle", "room", room, "err", err)
		return
	}
	// Inside the window: one trailing event per room, scheduled by whoever claims it.
	err = rc.redis.Do(ctx, rc.redis.B().Set().Key(key+":t").Value("1").Nx().Px(rc.window).Build()).Error()
	if err != nil {
		return
	}
	left, err := rc.redis.Do(ctx, rc.redis.B().Pttl().Key(key).Build()).AsInt64()
	if err != nil || left < 0 {
		left = 0
	}
	time.AfterFunc(time.Duration(left)*time.Millisecond, func() { rc.trailing(acc.WorkspaceID, room) })
}

// trailing sends the window's last event with the markers as they are now; it opens a new
// window, so a read right after it waits for the next trailing event.
func (rc *Receipts) trailing(ws, room uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	key := receiptKey(room)
	rc.redis.DoMulti(ctx,
		rc.redis.B().Set().Key(key).Value("1").Px(rc.window).Build(),
		rc.redis.B().Del().Key(key+":t").Build())
	top, err := rc.db.Q.TopRoomReads(ctx, room)
	if err != nil {
		slog.WarnContext(ctx, "read receipt: top reads", "room", room, "err", err)
		return
	}
	rc.publish(ctx, ws, room, top)
}

// publish sends the room's furthest marker to its viewers except its owner, who gets the
// second furthest on their own channel.
func (rc *Receipts) publish(ctx context.Context, ws, room uuid.UUID, top []sqlc.TopRoomReadsRow) {
	if len(top) == 0 {
		return
	}
	rc.events.Workspace(ctx, ws, receipt(room, top[0].LastReadMessageID, top[0].UserID))
	if len(top) > 1 {
		rc.events.User(ctx, top[0].UserID, receipt(room, top[1].LastReadMessageID, uuid.Nil))
	}
}

func receipt(room, mark, except uuid.UUID) *v1.DispatchEvent {
	pr := &v1.PeerRead{RoomId: room.String(), LastReadMessageId: mark.String()}
	if except != uuid.Nil {
		pr.ExceptUserId = except.String()
	}
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_ReadReceipt{ReadReceipt: pr}}
}
