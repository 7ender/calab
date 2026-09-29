//go:build integration

package app_test

import (
	"bytes"
	"context"
	"image/jpeg"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"testing"

	"github.com/calaba/calaba/server/internal/files"
)

// convertPost posts data as the multipart "file" to POST /api/files/convert?to=jpeg (token ""
// = no Authorization header).
func convertPost(t *testing.T, token, name string, data []byte) (int, []byte, string) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", name)
	_, _ = fw.Write(data)
	_ = mw.Close()
	req, _ := http.NewRequestWithContext(context.Background(), "POST", srv.URL+"/api/files/convert?to=jpeg", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, raw, resp.Header.Get("Content-Type")
}

// HEIC → JPEG for clients without a HEIF decoder (docs/02 «Изображения: клиентское сжатие и
// HEIC»): authenticated only, HEIF only (415), ≤ 25 MB (413), nothing stored.
func TestConvertHEIC(t *testing.T) {
	o := owner(t)
	heic, err := os.ReadFile("../files/testdata/grid-rot6.heic")
	if err != nil {
		t.Fatal(err)
	}
	if st, _, _ := convertPost(t, "", "a.heic", heic); st != http.StatusUnauthorized {
		t.Fatalf("no auth: %d, want 401", st)
	}
	if st, _, _ := convertPost(t, o.token, "a.png", pngBytes(16, 16)); st != http.StatusUnsupportedMediaType {
		t.Fatalf("png: %d, want 415", st)
	}
	if st, _, _ := convertPost(t, o.token, "a.txt", []byte("not an image at all, just some text")); st != http.StatusUnsupportedMediaType {
		t.Fatalf("text: %d, want 415", st)
	}
	big := append(append([]byte{}, heic[:64]...), make([]byte, files.MaxConvertBytes)...)
	if st, _, _ := convertPost(t, o.token, "big.heic", big); st != http.StatusRequestEntityTooLarge {
		t.Fatalf("25 MB + 64 B: %d, want 413", st)
	}

	st, raw, ct := convertPost(t, o.token, "IMG_0001.HEIC", heic)
	if st == http.StatusNotImplemented {
		t.Skip("ffmpeg/ffprobe ≥ 7.1 not on PATH: 501 checked, the conversion itself is not")
	}
	if st != 200 || ct != "image/jpeg" {
		t.Fatalf("convert: %d %q %s", st, ct, raw)
	}
	img, err := jpeg.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != 530 || b.Dy() != 1030 {
		t.Fatalf("size %dx%d, want 530x1030 (orientation 6 applied)", b.Dx(), b.Dy())
	}
}

// Avatars (docs/04 «Файлы»): the client uploads a 512×512 WebP; the server caps them at 512 KB.
func TestAvatarLimit(t *testing.T) {
	o := owner(t)
	if st, _, me := upload(t, o, "/api/me/avatar", "a.png", pngBytes(64, 64)); st != 200 || me.GetUser().GetAvatarFileId() == "" {
		t.Fatalf("small avatar: %d", st)
	}
	big := append(pngBytes(8, 8), make([]byte, files.MaxAvatarBytes)...)
	if st, _, _ := upload(t, o, "/api/me/avatar", "big.png", big); st != http.StatusRequestEntityTooLarge {
		t.Fatalf("avatar over 512 KB: %d, want 413", st)
	}
}
