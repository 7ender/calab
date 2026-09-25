package events

import (
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestEncodeDecode(t *testing.T) {
	ev := &v1.DispatchEvent{Event: &v1.DispatchEvent_TypingStart{TypingStart: &v1.TypingStart{RoomId: "r", UserId: "u"}}}
	b, err := Encode(ev)
	if err != nil {
		t.Fatal(err)
	}
	id, got, err := Decode(b)
	if err != nil || id == uuid.Nil || !proto.Equal(ev, got) {
		t.Fatalf("round trip: %v %v %v", id, got, err)
	}
	b2, _ := Encode(ev)
	if id2, _, _ := Decode(b2); id2 == id {
		t.Fatal("event ids repeat")
	}
	if _, _, err := Decode([]byte("short")); err == nil {
		t.Fatal("short payload accepted")
	}
	if WorkspaceChannel(uuid.Nil) != "ws:00000000-0000-0000-0000-000000000000" || UserChannel(id)[:5] != "user:" || RevokedChannel(id)[:16] != "session:revoked:" {
		t.Fatal("channel names")
	}
}
