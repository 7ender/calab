package rtc

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/livekit/protocol/livekit"
	lkjson "github.com/livekit/protocol/utils/protojson"
	"google.golang.org/protobuf/encoding/protojson"
)

// Our SIP request JSON must be what livekit-server's twirp decoder reads, and its answers
// (proto names) what we read — checked against the official types.
func TestSIPWireFormats(t *testing.T) {
	body, err := json.Marshal(sipCallBody(SIPCall{
		TrunkID: "ST_1", CallTo: "79161234567", Room: "ws_a_room_b", Identity: "sip:x", Name: "+79161234567",
		Attributes: map[string]string{"calab.callId": "x"}, WaitUntilAnswered: true,
		RingingTimeout: 45 * time.Second, MaxCallDuration: 2 * time.Hour,
	}))
	if err != nil {
		t.Fatal(err)
	}
	var req livekit.CreateSIPParticipantRequest
	if err := protojson.Unmarshal(body, &req); err != nil {
		t.Fatalf("livekit cannot read our request: %v\n%s", err, body)
	}
	if req.SipTrunkId != "ST_1" || req.SipCallTo != "79161234567" || req.RoomName != "ws_a_room_b" ||
		req.ParticipantIdentity != "sip:x" || req.ParticipantName != "+79161234567" || !req.WaitUntilAnswered ||
		req.RingingTimeout.AsDuration() != 45*time.Second || req.MaxCallDuration.AsDuration() != 2*time.Hour ||
		req.ParticipantAttributes["calab.callId"] != "x" {
		t.Fatalf("request: %v", &req)
	}

	trunk := SIPTrunk{Name: "calab-ws", Address: "sip.example.com:5060", Transport: SIPTransportTCP,
		Numbers: []string{"+74951234567"}, AuthUsername: "u", AuthPassword: "p"}
	for _, in := range []any{map[string]any{"trunk": trunk}, map[string]any{"sip_trunk_id": "ST_2", "replace": trunk}} {
		b, _ := json.Marshal(in)
		var c livekit.CreateSIPOutboundTrunkRequest
		var u livekit.UpdateSIPOutboundTrunkRequest
		var info *livekit.SIPOutboundTrunkInfo
		if strings.Contains(string(b), "replace") {
			if err := protojson.Unmarshal(b, &u); err != nil {
				t.Fatalf("update: %v %s", err, b)
			}
			info = u.GetReplace()
			if u.SipTrunkId != "ST_2" {
				t.Fatal("update trunk id")
			}
		} else {
			if err := protojson.Unmarshal(b, &c); err != nil {
				t.Fatalf("create: %v %s", err, b)
			}
			info = c.Trunk
		}
		if info.Address != "sip.example.com:5060" || info.Transport != livekit.SIPTransport_SIP_TRANSPORT_TCP ||
			len(info.Numbers) != 1 || info.AuthUsername != "u" || info.AuthPassword != "p" || info.Name != "calab-ws" {
			t.Fatalf("trunk: %v", info)
		}
	}

	answer, _ := protojson.MarshalOptions{UseProtoNames: true, EmitUnpopulated: true}.Marshal(&livekit.SIPParticipantInfo{
		ParticipantId: "PA_1", ParticipantIdentity: "sip:x", RoomName: "r", SipCallId: "SCL_1"})
	var p SIPParticipant
	if err := json.Unmarshal(answer, &p); err != nil || p.SIPCallID != "SCL_1" || p.Identity != "sip:x" || p.ParticipantID != "PA_1" {
		t.Fatalf("answer: %+v %v", p, err)
	}
	trunkAnswer, _ := protojson.MarshalOptions{UseProtoNames: true, EmitUnpopulated: true}.Marshal(&livekit.SIPOutboundTrunkInfo{SipTrunkId: "ST_9"})
	var ti SIPTrunk
	if err := json.Unmarshal(trunkAnswer, &ti); err != nil || ti.ID != "ST_9" {
		t.Fatalf("trunk answer: %+v %v", ti, err)
	}

	// Webhooks carry a phone line's attributes (lowerCamelCase JSON).
	wh, _ := lkjson.Marshal(&livekit.WebhookEvent{Event: "participant_joined", Participant: &livekit.ParticipantInfo{
		Identity: "sip:x", Kind: livekit.ParticipantInfo_SIP, Attributes: map[string]string{livekit.AttrSIPCallStatus: "ringing"}}})
	var ev WebhookEvent
	if err := json.Unmarshal(wh, &ev); err != nil || ev.Participant.Attributes[AttrSIPCallStatus] != "ringing" {
		t.Fatalf("webhook: %v %v", ev.Participant, err)
	}
	if livekit.AttrSIPCallStatus != AttrSIPCallStatus || livekit.AttrSIPCallID != AttrSIPCallID {
		t.Fatal("attribute names drifted")
	}
}

// The client signs SIP calls with the sip grant, and SIP errors expose the SIP status.
func TestSIPClient(t *testing.T) {
	var gotPath string
	var gotClaims jwt.MapClaims
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		gotClaims = jwt.MapClaims{}
		if _, err := jwt.ParseWithClaims(tok, gotClaims, func(*jwt.Token) (any, error) { return []byte("secret-secret-secret-secret-secret"), nil }); err != nil {
			t.Error(err)
		}
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"code":"unavailable","msg":"sip status 486: Busy Here","meta":{"sip_status_code":"486","sip_status":"Busy Here"}}`))
	}))
	defer srv.Close()
	c := NewSIP(srv.URL, "key", "secret-secret-secret-secret-secret")
	_, err := c.CreateSIPParticipant(context.Background(), SIPCall{TrunkID: "ST", CallTo: "1", Room: "r", Identity: SIPIdentity(uuid.New())})
	if code, text := SIPStatus(err); code != 486 || text != "Busy Here" {
		t.Fatalf("status: %d %q (%v)", code, text, err)
	}
	if gotPath != "/twirp/livekit.SIP/CreateSIPParticipant" {
		t.Fatal(gotPath)
	}
	if g, ok := gotClaims["sip"].(map[string]any); !ok || g["call"] != true {
		t.Fatalf("grant: %v", gotClaims)
	}
	if code, _ := SIPStatus(&Error{Msg: "sip status 404: Not Found"}); code != 404 {
		t.Fatal("message fallback")
	}
	if id := uuid.New(); SIPIdentity(id) != "sip:"+id.String() {
		t.Fatal("identity")
	} else if got, ok := ParseSIPIdentity(SIPIdentity(id)); !ok || got != id {
		t.Fatal("parse identity")
	}
	if _, ok := ParseSIPIdentity(uuid.NewString() + ":" + uuid.NewString()); ok {
		t.Fatal("a device identity parsed as a phone line")
	}
}
