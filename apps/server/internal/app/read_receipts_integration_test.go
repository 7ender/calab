//go:build integration

package app_test

import (
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/messages"
)

func receiptOf(roomID string) func(*v1.DispatchEvent) bool {
	return func(e *v1.DispatchEvent) bool { return e.GetReadReceipt().GetRoomId() == roomID }
}

func readUpTo(t *testing.T, c *client, roomID, messageID string) {
	t.Helper()
	c.must(204, "PUT", "/api/rooms/"+roomID+"/read", &v1.UpdateReadStateRequest{MessageId: messageID}, nil)
}

func wantReceipt(t *testing.T, g *gw, who, roomID, messageID string) {
	t.Helper()
	e := g.wait("READ_RECEIPT "+who, receiptOf(roomID))
	if pr := e.GetReadReceipt(); pr.GetLastReadMessageId() != messageID || pr.GetExceptUserId() != "" {
		t.Fatalf("READ_RECEIPT %s: %v, want %s", who, pr, messageID)
	}
}

// TestReadReceiptsDM: the peer's read goes to the author at once (docs/09 #92), not to the
// reader's own devices, only when the marker moves; READY and GET /api/dms carry it.
func TestReadReceiptsDM(t *testing.T) {
	o, bob, _, _ := setupTeam(t)
	rid := openDM(t, o, bob.id, 201).GetRoom().GetId()
	og, bg := dialGW(t), dialGW(t)
	og.identify(o.token)
	bg.identify(bob.token)
	m1 := send(t, o, rid, "one", uniq("rr-dm-1-"))
	m2 := send(t, o, rid, "two", uniq("rr-dm-2-"))

	readUpTo(t, bob.client, rid, m1.GetId())
	wantReceipt(t, og, "o", rid, m1.GetId())
	bg.quiet("own READ_RECEIPT", 300*time.Millisecond, receiptOf(rid))
	// Not moved (same / older marker): no event.
	readUpTo(t, bob.client, rid, m1.GetId())
	og.quiet("READ_RECEIPT without a move", 300*time.Millisecond, receiptOf(rid))

	og = dialGW(t) // the same device: replaces the previous socket
	ready := og.identify(o.token)
	for _, d := range ready.GetDms() {
		if d.GetRoom().GetId() == rid && d.GetPeerReadMessageId() != m1.GetId() {
			t.Fatalf("READY dm peer_read_message_id = %q, want %s", d.GetPeerReadMessageId(), m1.GetId())
		}
	}
	readUpTo(t, bob.client, rid, m2.GetId())
	wantReceipt(t, og, "o (2)", rid, m2.GetId())
	// o is the instance owner shared by every test (owner()): pick this DM out of their list.
	if got := dmPeerRead(t, o, rid); got != m2.GetId() {
		t.Fatalf("GET /api/dms peer read: %q, want %s", got, m2.GetId())
	}
	// The peer's summary shows o's marker: sending moved it to o's last message.
	if got := dmPeerRead(t, bob, rid); got != m2.GetId() {
		t.Fatalf("bob's peer read: %q, want %s", got, m2.GetId())
	}
}

// dmPeerRead returns peer_read_message_id of the DM rid in u's GET /api/dms.
func dmPeerRead(t *testing.T, u *user, rid string) string {
	t.Helper()
	var dl v1.ListDmsResponse
	u.must(200, "GET", "/api/dms", nil, &dl)
	for _, d := range dl.GetDms() {
		if d.GetRoom().GetId() == rid {
			return d.GetPeerReadMessageId()
		}
	}
	t.Fatalf("GET /api/dms: no DM %s", rid)
	return ""
}

// TestReadReceiptsRoom: in a workspace room the furthest marker of the others goes to the
// members at most once per window (a leading and a trailing event), only when it advances for
// someone; bots' reads do not count and bots get no receipts.
func TestReadReceiptsRoom(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	b := createBot(t, o, wid, "Reader")
	rid := textRoom(t, o, wid, "receipts", false)
	og, bg, cg, botg := dialGW(t), dialGW(t), dialGW(t), dialGW(t)
	og.identify(o.token)
	bg.identify(bob.token)
	cg.identify(carol.token)
	botg.identify(b.token)
	m1 := send(t, o, rid, "one", uniq("rr-1-"))
	m2 := send(t, o, rid, "two", uniq("rr-2-"))
	m3 := send(t, o, rid, "three", uniq("rr-3-"))

	// Sending moved o's own marker to m3. Leading edge, at once: o (the furthest reader) gets
	// the next furthest — bob's m1 — on his own channel, the others get o's m3.
	start := time.Now()
	readUpTo(t, bob.client, rid, m1.GetId())
	wantReceipt(t, og, "o", rid, m1.GetId())
	wantReceipt(t, cg, "carol", rid, m3.GetId())
	wantReceipt(t, bg, "bob", rid, m3.GetId())

	// Inside the window: no event now, one trailing event at its end with the state then.
	readUpTo(t, bob.client, rid, m2.GetId())
	readUpTo(t, carol.client, rid, m3.GetId())
	og.quiet("READ_RECEIPT inside the window", messages.ReceiptWindow-time.Since(start)-300*time.Millisecond, receiptOf(rid))
	wantReceipt(t, og, "o (trailing)", rid, m3.GetId())
	wantReceipt(t, cg, "carol (trailing)", rid, m3.GetId())
	og.quiet("a second trailing READ_RECEIPT", 500*time.Millisecond, receiptOf(rid))

	// Moves, but nothing advances for anyone: bob reads m3 (o and carol are at m3 already).
	time.Sleep(messages.ReceiptWindow)
	readUpTo(t, bob.client, rid, m3.GetId())
	cg.quiet("READ_RECEIPT without an advance", 500*time.Millisecond, receiptOf(rid))
	// Does not move: o's marker is past m2.
	readUpTo(t, o.client, rid, m2.GetId())
	cg.quiet("READ_RECEIPT without a move", 300*time.Millisecond, receiptOf(rid))

	// A bot's read: no event, and it does not count in READY.
	m4 := send(t, o, rid, "four", uniq("rr-4-"))
	readUpTo(t, b.client, rid, m4.GetId())
	og.quiet("READ_RECEIPT for a bot's read", 500*time.Millisecond, receiptOf(rid))
	ready := dialGW(t).identify(o.token)
	found := false
	for _, pr := range ready.GetPeerReads() {
		if pr.GetRoomId() == rid {
			found = true
			if pr.GetLastReadMessageId() != m3.GetId() || pr.GetExceptUserId() != "" {
				t.Fatalf("READY peer read: %v, want %s", pr, m3.GetId())
			}
		}
	}
	if !found {
		t.Fatal("READY.peer_reads misses the room")
	}
	botg.quiet("READ_RECEIPT to a bot", 200*time.Millisecond, receiptOf(rid))
}
