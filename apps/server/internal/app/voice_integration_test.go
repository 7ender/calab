//go:build integration

package app_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// oggOpus is the start of an Ogg/Opus stream (an ID-header page) padded to size bytes.
func oggOpus(size int) []byte {
	b := append([]byte("OggS\x00\x02"), make([]byte, 20)...)
	b = append(b, 1, 19)
	b = append(b, "OpusHead\x01\x01\x38\x01\x80\xbb\x00\x00\x00\x00\x00"...)
	return append(b, bytes.Repeat([]byte{0x55}, max(0, size-len(b)))...)
}

// uploadAs posts one file with a declared Content-Type to path (+ query).
func uploadAs(t *testing.T, u *user, path, name, mime string, data []byte) (int, *v1.FileMeta) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", `form-data; name="file"; filename="`+name+`"`)
	h.Set("Content-Type", mime)
	fw, _ := mw.CreatePart(h)
	_, _ = fw.Write(data)
	_ = mw.Close()
	req, _ := http.NewRequestWithContext(context.Background(), "POST", srv.URL+path, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+u.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		t.Logf("upload %s -> %d %s", name, resp.StatusCode, raw)
		return resp.StatusCode, nil
	}
	var r v1.UploadFileResponse
	if err := protojson.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, r.GetFile()
}

// TestVoiceMessages: docs/09 #43 — a voice upload (Ogg/Opus, audio/ogg, duration + waveform)
// round-trips through a message and history, in a workspace room and a DM; malformed ones
// are refused.
func TestVoiceMessages(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	wsFiles := "/api/workspaces/" + ws.GetId() + "/files"
	bars := []byte{0, 12, 128, 255, 64}
	q := "?voice_duration_ms=4200&voice_waveform=" + base64.RawURLEncoding.EncodeToString(bars)
	data := oggOpus(4000)

	st, f := uploadAs(t, bob, wsFiles+q, "voice.ogg", "audio/ogg", data)
	if st != 201 || f.GetMime() != "audio/ogg" || f.GetVoice().GetDurationMs() != 4200 || !bytes.Equal(f.GetVoice().GetWaveform(), bars) {
		t.Fatalf("voice upload: %d %v", st, f)
	}
	var cm v1.CreateMessageResponse
	bob.must(201, "POST", "/api/rooms/"+room.GetId()+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{f.GetId()}, Nonce: uniq("v")}, &cm)
	if a := cm.GetMessage().GetAttachments(); len(a) != 1 || a[0].GetVoice().GetDurationMs() != 4200 {
		t.Fatalf("message attachment: %v", a)
	}
	var page v1.ListMessagesResponse
	o.must(200, "GET", "/api/rooms/"+room.GetId()+"/messages?limit=1", nil, &page)
	if m := page.GetMessages(); len(m) != 1 || !bytes.Equal(m[0].GetAttachments()[0].GetVoice().GetWaveform(), bars) {
		t.Fatalf("history: %v", m)
	}
	resp, body := get(t, o, f.GetUrl(), nil)
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "audio/ogg" || !bytes.Equal(body, data) {
		t.Fatalf("download: %d %v", resp.StatusCode, resp.Header)
	}

	// A plain upload of the same file is an ordinary attachment (no voice).
	if st, f := uploadAs(t, bob, wsFiles, "song.ogg", "audio/ogg", data); st != 201 || f.GetVoice() != nil {
		t.Fatalf("plain ogg: %d %v", st, f)
	}

	// Refused: not Ogg/Opus, another declared type, bad metadata, over the size limit
	// (MAX_FILE_SIZE_MB=1 in tests is below the 1.5 MB voice cap).
	for _, c := range []struct {
		name, query, mime string
		data              []byte
		want              int
	}{
		{"webm", q, "audio/ogg", append([]byte("\x1a\x45\xdf\xa3"), make([]byte, 100)...), 422},
		{"vorbis", q, "audio/ogg", append([]byte("OggS\x00\x02"), make([]byte, 60)...), 422},
		{"declared webm", q, "audio/webm", data, 422},
		{"no duration", "?voice_waveform=AAA", "audio/ogg", data, 422},
		{"too long", "?voice_duration_ms=300001", "audio/ogg", data, 422},
		{"too many bars", "?voice_duration_ms=1000&voice_waveform=" + base64.RawURLEncoding.EncodeToString(make([]byte, 101)), "audio/ogg", data, 422},
		{"too large", q, "audio/ogg", oggOpus(1<<20 + 10), 413},
	} {
		if st, _ := uploadAs(t, bob, wsFiles+c.query, "v.ogg", c.mime, c.data); st != c.want {
			t.Errorf("%s: %d, want %d", c.name, st, c.want)
		}
	}

	// DM: the same through POST /api/dms/{id}/files.
	dm := openDM(t, o, bob.id, 201)
	st, df := uploadAs(t, o, "/api/dms/"+dm.GetRoom().GetId()+"/files"+q, "voice.ogg", "audio/ogg", data)
	if st != 201 || df.GetVoice().GetDurationMs() != 4200 {
		t.Fatalf("dm voice upload: %d %v", st, df)
	}
	var dmm v1.CreateMessageResponse
	o.must(201, "POST", "/api/rooms/"+dm.GetRoom().GetId()+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{df.GetId()}, Nonce: uniq("dv")}, &dmm)
	if a := dmm.GetMessage().GetAttachments(); len(a) != 1 || a[0].GetVoice() == nil {
		t.Fatalf("dm attachment: %v", a)
	}
}
