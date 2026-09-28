//go:build integration

package app_test

import (
	"bytes"
	"context"
	"testing"

	"github.com/google/uuid"
	xwebp "golang.org/x/image/webp"

	"github.com/calaba/calaba/server/internal/blob"
)

// TestThumbnailSizes: ?w=512|1024, lazy 1024 generation cached in the store, no upscale, 400.
func TestThumbnailSizes(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	ctx := context.Background()
	size := func(b []byte) (int, int) {
		t.Helper()
		cfg, err := xwebp.DecodeConfig(bytes.NewReader(b))
		if err != nil {
			t.Fatalf("not WebP: %v", err)
		}
		return cfg.Width, cfg.Height
	}

	_, f, _ := upload(t, o, "/api/workspaces/"+ws.GetId()+"/files", "big.png", pngBytes(1200, 600))
	large := blob.LargeThumbKey(blob.FileKey(uuid.MustParse(ws.GetId()), uuid.MustParse(f.GetId())))
	if _, err := testStore.Stat(ctx, large); err == nil {
		t.Fatal("1024 thumbnail made at upload, want lazily")
	}
	// No parameter and w=512: the upload-time 512 px thumbnail.
	resp, def := get(t, o, f.GetThumbnailUrl(), nil)
	if resp.StatusCode != 200 {
		t.Fatalf("thumbnail: %d", resp.StatusCode)
	}
	if w, h := size(def); w != 512 || h != 256 {
		t.Fatalf("default thumbnail %dx%d", w, h)
	}
	resp, b512 := get(t, o, f.GetThumbnailUrl()+"?w=512", nil)
	if resp.StatusCode != 200 || !bytes.Equal(b512, def) {
		t.Fatalf("w=512: %d", resp.StatusCode)
	}
	// w=1024: generated on first request, stored, then served from the store.
	resp, b1024 := get(t, o, f.GetThumbnailUrl()+"?w=1024", nil)
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/webp" ||
		resp.Header.Get("Cache-Control") != "private, max-age=31536000, immutable" {
		t.Fatalf("w=1024: %d %v", resp.StatusCode, resp.Header)
	}
	if w, h := size(b1024); w != 1024 || h != 512 {
		t.Fatalf("1024 thumbnail %dx%d", w, h)
	}
	if _, err := testStore.Stat(ctx, large); err != nil {
		t.Fatalf("1024 thumbnail not cached: %v", err)
	}
	etag := resp.Header.Get("ETag")
	if etag == "" || etag == `"`+f.GetSha256()+`-t"` {
		t.Fatalf("1024 ETag %q must differ from the 512 one", etag)
	}
	resp, again := get(t, o, f.GetThumbnailUrl()+"?w=1024", nil)
	if resp.StatusCode != 200 || !bytes.Equal(again, b1024) {
		t.Fatalf("cached w=1024: %d", resp.StatusCode)
	}
	if resp, _ := get(t, o, f.GetThumbnailUrl()+"?w=1024", map[string]string{"If-None-Match": etag}); resp.StatusCode != 304 {
		t.Fatalf("1024 etag: %d", resp.StatusCode)
	}
	for _, bad := range []string{"256", "2048", "abc", "1024px"} {
		if resp, _ := get(t, o, f.GetThumbnailUrl()+"?w="+bad, nil); resp.StatusCode != 400 {
			t.Fatalf("w=%s: %d, want 400", bad, resp.StatusCode)
		}
	}

	// Between 512 and 1024: own size, re-encoded, never upscaled.
	_, mid, _ := upload(t, o, "/api/workspaces/"+ws.GetId()+"/files", "mid.png", pngBytes(800, 300))
	_, b := get(t, o, mid.GetThumbnailUrl()+"?w=1024", nil)
	if w, h := size(b); w != 800 || h != 300 {
		t.Fatalf("mid 1024 thumbnail %dx%d", w, h)
	}
	// Up to 512: the 512 thumbnail already is the original size, served for w=1024 as is.
	_, small, _ := upload(t, o, "/api/workspaces/"+ws.GetId()+"/files", "small.png", pngBytes(300, 200))
	_, s512 := get(t, o, small.GetThumbnailUrl(), nil)
	resp, s1024 := get(t, o, small.GetThumbnailUrl()+"?w=1024", nil)
	if resp.StatusCode != 200 || !bytes.Equal(s512, s1024) {
		t.Fatalf("small w=1024: %d, same as 512 = %v", resp.StatusCode, bytes.Equal(s512, s1024))
	}
	smallLarge := blob.LargeThumbKey(blob.FileKey(uuid.MustParse(ws.GetId()), uuid.MustParse(small.GetId())))
	if _, err := testStore.Stat(ctx, smallLarge); err == nil {
		t.Fatal("1024 thumbnail stored for an image that fits 512")
	}
}
