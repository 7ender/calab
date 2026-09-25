package gateway

import (
	"bytes"
	"testing"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

func TestEntryRoundTripAndSince(t *testing.T) {
	var es []entry
	for i := uint64(5); i <= 9; i++ {
		e := entry{id: uuid.New(), seq: i, frame: []byte{byte(i), ':', 0}}
		d, err := decodeEntry(e.encode())
		if err != nil || d.id != e.id || d.seq != e.seq || !bytes.Equal(d.frame, e.frame) {
			t.Fatalf("round trip: %+v %v", d, err)
		}
		es = append(es, d)
	}
	if out, ok := since(es, 6, 9); !ok || len(out) != 3 || out[0].seq != 7 {
		t.Fatalf("since 6: %v %v", ok, out)
	}
	if out, ok := since(es, 9, 9); !ok || len(out) != 0 {
		t.Fatal("up to date client")
	}
	if _, ok := since(es, 4, 9); !ok {
		t.Fatal("seq just before the first buffered entry is resumable")
	}
	if _, ok := since(es, 2, 9); ok {
		t.Fatal("trimmed history must not be resumable")
	}
	if _, ok := since(es, 10, 9); ok {
		t.Fatal("seq from the future must not be resumable")
	}
	if _, ok := since(nil, 3, 3); !ok {
		t.Fatal("no events since last seq: resumable")
	}
}

func TestAggregateStatus(t *testing.T) {
	on, idle, dnd, inv := v1.PresenceStatus_PRESENCE_STATUS_ONLINE, v1.PresenceStatus_PRESENCE_STATUS_IDLE,
		v1.PresenceStatus_PRESENCE_STATUS_DND, v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE
	off := v1.PresenceStatus_PRESENCE_STATUS_OFFLINE
	for _, c := range []struct {
		in   []v1.PresenceStatus
		want v1.PresenceStatus
	}{
		{nil, off}, {[]v1.PresenceStatus{inv}, off}, {[]v1.PresenceStatus{idle, inv}, idle},
		{[]v1.PresenceStatus{idle, on}, on}, {[]v1.PresenceStatus{on, dnd, idle}, dnd},
	} {
		if got := AggregateStatus(c.in); got != c.want {
			t.Errorf("%v: got %v want %v", c.in, got, c.want)
		}
	}
}

func TestCodec(t *testing.T) {
	f := frame(&v1.GatewayFrame{Seq: 3, Payload: &v1.GatewayFrame_Dispatch{Dispatch: &v1.DispatchEvent{
		Event: &v1.DispatchEvent_TypingStart{TypingStart: &v1.TypingStart{RoomId: "r", UserId: "u"}}}}})
	if f.GetOp() != v1.GatewayOpcode_GATEWAY_OPCODE_DISPATCH {
		t.Fatal("opcode not derived")
	}
	for _, c := range []codec{{}, {json: true}} {
		typ, b, err := c.encode(f)
		if err != nil {
			t.Fatal(err)
		}
		if c.json != (typ == websocket.MessageText) {
			t.Fatal("wrong message type")
		}
		g, err := c.decode(typ, b)
		if err != nil || g.GetSeq() != 3 || g.GetDispatch().GetTypingStart().GetRoomId() != "r" {
			t.Fatalf("decode: %v %v", g, err)
		}
	}
	_, bb, _ := codec{}.encode(f)
	typ, js, err := codec{json: true}.transcode(bb)
	if err != nil || typ != websocket.MessageText || !bytes.Contains(js, []byte(`"GATEWAY_OPCODE_DISPATCH"`)) {
		t.Fatalf("transcode: %s %v", js, err)
	}
}

func TestVisibilityTransitions(t *testing.T) {
	wid, rid, alice, bob := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := &v1.Room{Id: rid.String()}
	st := &wsState{rooms: map[uuid.UUID]*v1.Room{rid: room}, roles: map[uuid.UUID]perm.Role{alice: perm.RoleMember, bob: perm.RoleGuest}}
	if !st.canView(rid, alice) || st.canView(rid, bob) {
		t.Fatal("defaults: member sees, guest does not")
	}
	private := []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Deny: uint64(perm.ViewRoom)},
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.String(), Allow: uint64(perm.ViewRoom)},
	}
	st.rooms[rid] = withPermissions(room, private)
	if st.canView(rid, alice) || !st.canView(rid, bob) {
		t.Fatal("private room: alice hidden, bob allowed")
	}
	upd := &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomUpdate{RoomUpdate: &v1.RoomUpdate{Room: room}}}
	if ev := transition(true, true, upd, room, wid, rid); ev != upd {
		t.Fatal("still visible: pass through")
	}
	if ev := transition(false, true, upd, room, wid, rid); ev.GetRoomCreate() == nil {
		t.Fatal("gained: ROOM_CREATE")
	}
	if ev := transition(true, false, upd, room, wid, rid); ev.GetRoomDelete().GetRoomId() != rid.String() {
		t.Fatal("lost: ROOM_DELETE")
	}
	if transition(false, false, upd, room, wid, rid) != nil {
		t.Fatal("never visible: nothing")
	}
	vs := &v1.VoiceState{UserId: "u", RoomId: rid.String(), Muted: true}
	if got := sanitizeVoice(vs, func(uuid.UUID) bool { return false }); got.GetRoomId() != "" || got.GetMuted() {
		t.Fatal("hidden room leaked in voice state")
	}
	if got := sanitizeVoice(vs, func(uuid.UUID) bool { return true }); got != vs {
		t.Fatal("visible voice state changed")
	}
}
