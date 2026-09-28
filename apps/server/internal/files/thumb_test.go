package files

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"io"
	"testing"
	"time"

	xwebp "golang.org/x/image/webp"
)

func pngOf(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 128, 255}) //nolint:gosec // test pattern
		}
	}
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	return b.Bytes()
}

func opener(b []byte) func() (io.ReadCloser, error) {
	return func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(b)), nil }
}

func TestThumbnail(t *testing.T) {
	src := pngOf(2000, 1000)
	start := time.Now()
	out, err := Thumbnail(context.Background(), opener(src))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("2000x1000 PNG -> %d bytes WebP in %v", len(out), time.Since(start))
	cfg, err := xwebp.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("thumbnail is not WebP: %v", err)
	}
	if cfg.Width != 512 || cfg.Height != 256 {
		t.Fatalf("thumbnail size %dx%d", cfg.Width, cfg.Height)
	}
	// Small images are not upscaled.
	out, err = Thumbnail(context.Background(), opener(pngOf(100, 40)))
	if err != nil {
		t.Fatal(err)
	}
	if cfg, _ := xwebp.DecodeConfig(bytes.NewReader(out)); cfg.Width != 100 || cfg.Height != 40 {
		t.Fatalf("small image resized to %dx%d", cfg.Width, cfg.Height)
	}
	if _, err := Thumbnail(context.Background(), opener([]byte("not an image"))); err == nil {
		t.Fatal("garbage accepted")
	}
}

func TestThumbSize(t *testing.T) {
	for _, c := range [][4]int{{512, 512, 512, 512}, {1024, 512, 512, 256}, {300, 3000, 51, 512}, {10000, 1, 512, 1}} {
		if w, h := ThumbSize(c[0], c[1]); w != c[2] || h != c[3] {
			t.Errorf("%dx%d -> %dx%d, want %dx%d", c[0], c[1], w, h, c[2], c[3])
		}
	}
}

func TestLargeThumbnail(t *testing.T) {
	for _, c := range [][4]int{{2000, 1000, 1024, 512}, {800, 300, 800, 300}, {600, 3000, 204, 1024}} {
		out, err := LargeThumbnail(context.Background(), opener(pngOf(c[0], c[1])))
		if err != nil {
			t.Fatal(err)
		}
		cfg, err := xwebp.DecodeConfig(bytes.NewReader(out))
		if err != nil {
			t.Fatalf("large thumbnail is not WebP: %v", err)
		}
		if cfg.Width != c[2] || cfg.Height != c[3] { // never upscaled
			t.Errorf("%dx%d -> %dx%d, want %dx%d", c[0], c[1], cfg.Width, cfg.Height, c[2], c[3])
		}
	}
}

func TestFitSizeLarge(t *testing.T) {
	for _, c := range [][4]int{{1024, 1024, 1024, 1024}, {700, 500, 700, 500}, {4096, 1024, 1024, 256}, {1, 5000, 1, 1024}} {
		if w, h := FitSize(c[0], c[1], ThumbLargeSide); w != c[2] || h != c[3] {
			t.Errorf("%dx%d -> %dx%d, want %dx%d", c[0], c[1], w, h, c[2], c[3])
		}
	}
}

func TestThumbWidth(t *testing.T) {
	for q, want := range map[string]int{"": 512, "512": 512, "1024": 1024, "256": 0, "2048": 0, "1024 ": 0, "abc": 0} {
		got, ok := ThumbWidth(q)
		if ok != (want != 0) || got != want {
			t.Errorf("ThumbWidth(%q) = %d, %v; want %d", q, got, ok, want)
		}
	}
}
