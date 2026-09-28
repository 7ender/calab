//go:build integration

package app_test

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// botAvatarUpload posts a multipart "file" to …/bots/{botId}/avatar as c.
func botAvatarUpload(t *testing.T, token, path, name string, data []byte) (int, *v1.Bot) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", name)
	_, _ = fw.Write(data)
	_ = mw.Close()
	req, _ := http.NewRequestWithContext(context.Background(), "POST", srv.URL+path, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return resp.StatusCode, nil
	}
	var r v1.SetBotAvatarResponse
	if err := protojson.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, r.GetBot()
}

// Managers set and remove a bot's avatar from the UI (docs/09 #87): the avatar pipeline of
// POST /api/me/avatar, USER_UPDATE to members, 403 for members, 404 for a foreign bot.
func TestBotAvatar(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	bob := register(t, invite(t, o, ws.GetId()))
	b := createBot(t, o, ws.GetId(), "Painter")
	path := "/api/workspaces/" + ws.GetId() + "/bots/" + b.id + "/avatar"

	bg := dialGW(t)
	bg.identify(bob.token)

	st, pb := botAvatarUpload(t, o.token, path, "a.png", pngBytes(64, 64))
	if st != 200 || pb.GetUser().GetAvatarFileId() == "" || pb.GetUser().GetId() != b.id {
		t.Fatalf("set: %d %v", st, pb)
	}
	fid := pb.GetUser().GetAvatarFileId()
	bg.wait("USER_UPDATE with the bot avatar", func(e *v1.DispatchEvent) bool {
		u := e.GetUserUpdate().GetUser()
		return u.GetId() == b.id && u.GetAvatarFileId() == fid
	})
	if resp, _ := get(t, bob, "/api/files/"+fid, nil); resp.StatusCode != 200 {
		t.Fatalf("bot avatar readable by members: %d", resp.StatusCode)
	}
	var me v1.GetMeResponse
	b.must(200, "GET", "/api/me", nil, &me)
	if me.GetMe().GetUser().GetAvatarFileId() != fid {
		t.Fatalf("bot sees its avatar: %v", me.GetMe().GetUser())
	}

	// Not an image: 422 as for POST /api/me/avatar.
	if st, _ := botAvatarUpload(t, o.token, path, "a.txt", []byte("not an image")); st != 422 {
		t.Fatalf("non-image: %d, want 422", st)
	}
	// A member without MANAGE_WORKSPACE: 403 for both.
	if st, _ := botAvatarUpload(t, bob.token, path, "a.png", pngBytes(8, 8)); st != 403 {
		t.Fatalf("member set: %d, want 403", st)
	}
	bob.must(403, "DELETE", path, nil, nil)
	// A bot of another workspace through this one: 404.
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	foreign := createBot(t, o, ws2.GetId(), "Stranger")
	fpath := "/api/workspaces/" + ws.GetId() + "/bots/" + foreign.id + "/avatar"
	if st, _ := botAvatarUpload(t, o.token, fpath, "a.png", pngBytes(8, 8)); st != 404 {
		t.Fatalf("foreign bot set: %d, want 404", st)
	}
	o.must(404, "DELETE", fpath, nil, nil)
	// The bot itself: people-only route.
	b.must(403, "DELETE", path, nil, nil)

	// Clear.
	var cr v1.SetBotAvatarResponse
	o.must(200, "DELETE", path, nil, &cr)
	if cr.GetBot().GetUser().GetAvatarFileId() != "" {
		t.Fatalf("clear: %v", cr.GetBot().GetUser())
	}
	bg.wait("USER_UPDATE without the bot avatar", func(e *v1.DispatchEvent) bool {
		u := e.GetUserUpdate().GetUser()
		return u.GetId() == b.id && u.GetAvatarFileId() == ""
	})
}
