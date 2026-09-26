package dms

import (
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

func TestKeyIsSymmetric(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	if Key(a, b) != Key(b, a) {
		t.Fatal("key depends on the order of participants")
	}
	lo, hi := a.String(), b.String()
	if hi < lo {
		lo, hi = hi, lo
	}
	if Key(a, b) != lo+":"+hi {
		t.Fatalf("key %q", Key(a, b))
	}
}

func TestSummary(t *testing.T) {
	room, peer, last := uuid.New(), uuid.New(), uuid.New()
	now := time.Now()
	s := Summary(sqlc.ListDMsRow{RoomID: room, RoomCreatedAt: now, User: sqlc.User{ID: peer, DisplayName: "Bob"},
		UnreadCount: 3, LastMessageID: room, LastMessageAt: now})
	if s.GetRoom().GetType() != v1.RoomType_ROOM_TYPE_DM || s.GetRoom().GetWorkspaceId() != "" || s.GetPeer().GetId() != peer.String() {
		t.Fatalf("summary: %v", s)
	}
	// Every DM message counts as a mention; without messages nothing points at the room id.
	if rs := s.GetReadState(); rs.GetUnreadCount() != 3 || rs.GetMentionCount() != 3 || rs.GetLastReadMessageId() != "" {
		t.Fatalf("read state: %v", rs)
	}
	if s.GetLastMessageAt() != nil || s.GetRoom().GetLastMessageId() != "" {
		t.Fatalf("no messages yet, got last message %v", s)
	}
	s = Summary(sqlc.ListDMsRow{RoomID: room, User: sqlc.User{ID: peer}, HasMessages: true, LastMessageID: last,
		LastMessageAt: now, LastReadMessageID: &last})
	if s.GetRoom().GetLastMessageId() != last.String() || s.GetLastMessageAt() == nil || s.GetReadState().GetLastReadMessageId() != last.String() {
		t.Fatalf("with messages: %v", s)
	}
}
