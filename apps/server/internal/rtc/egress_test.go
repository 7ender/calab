package rtc

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	lkjson "github.com/livekit/protocol/utils/protojson"
	"google.golang.org/protobuf/encoding/protojson"
)

// EgressInfo must read what LiveKit sends: webhooks (lowerCamelCase, int64 as strings) and
// twirp answers (proto names, unpopulated fields emitted).
func TestEgressInfoWireFormats(t *testing.T) {
	src := &livekit.EgressInfo{
		EgressId: "EG_1", RoomName: "ws_a_room_b", Status: livekit.EgressStatus_EGRESS_COMPLETE, Error: "",
		FileResults: []*livekit.FileInfo{{Filename: "/out/a/b.mp4", Size: 123456789012, Duration: int64(95 * time.Second)}},
	}
	webhookJSON, err := lkjson.Marshal(&livekit.WebhookEvent{Event: "egress_ended", EgressInfo: src})
	if err != nil {
		t.Fatal(err)
	}
	var ev WebhookEvent
	if err := json.Unmarshal(webhookJSON, &ev); err != nil {
		t.Fatal(err)
	}
	twirpJSON, err := protojson.MarshalOptions{UseProtoNames: true, EmitUnpopulated: true}.Marshal(src)
	if err != nil {
		t.Fatal(err)
	}
	var fromTwirp EgressInfo
	if err := json.Unmarshal(twirpJSON, &fromTwirp); err != nil {
		t.Fatal(err)
	}
	for name, got := range map[string]*EgressInfo{"webhook": ev.Egress(), "twirp": &fromTwirp} {
		if got == nil || got.EgressID != "EG_1" || got.RoomName != "ws_a_room_b" || got.Status != EgressComplete || !got.Ended() ||
			got.File().Size != 123456789012 || got.File().Duration != 95*time.Second || got.File().Filename != "/out/a/b.mp4" {
			t.Fatalf("%s: %+v", name, got)
		}
	}
	var numeric EgressInfo
	if err := json.Unmarshal([]byte(`{"egressId":"EG_2","status":1,"file":{"size":5,"duration":"7"}}`), &numeric); err != nil {
		t.Fatal(err)
	}
	if numeric.Status != EgressActive || numeric.Ended() || numeric.File().Size != 5 || numeric.File().Duration != 7 {
		t.Fatalf("numeric / legacy file: %+v", numeric)
	}
}
