package files

import (
	"bytes"
	"context"
	"image"
	"testing"

	xwebp "golang.org/x/image/webp"
)

func TestCoverRect(t *testing.T) {
	cases := []struct {
		w, h int
		want image.Rectangle
	}{
		{1920, 1080, image.Rect(0, 0, 1920, 1080)},
		{2000, 1000, image.Rect(111, 0, 1888, 1000)}, // wider: sides cropped
		{1000, 1000, image.Rect(0, 219, 1000, 781)},  // taller: top and bottom cropped
		{1, 1, image.Rect(0, 0, 1, 1)},
		{0, 10, image.Rectangle{}},
	}
	for _, c := range cases {
		if got := CoverRect(c.w, c.h, 16, 9); got != c.want {
			t.Errorf("CoverRect(%d, %d) = %v, want %v", c.w, c.h, got, c.want)
		}
	}
}

func TestBackgroundImages(t *testing.T) {
	for _, size := range [][2]int{{2000, 1000}, {300, 400}} {
		full, thumb, err := BackgroundImages(context.Background(), opener(pngOf(size[0], size[1])))
		if err != nil {
			t.Fatal(err)
		}
		for _, x := range []struct {
			b    []byte
			w, h int
		}{{full, BackgroundWidth, BackgroundHeight}, {thumb, BackgroundThumbWidth, BackgroundThumbHeight}} {
			cfg, err := xwebp.DecodeConfig(bytes.NewReader(x.b))
			if err != nil {
				t.Fatalf("not WebP: %v", err)
			}
			if cfg.Width != x.w || cfg.Height != x.h {
				t.Fatalf("%v: %dx%d, want %dx%d", size, cfg.Width, cfg.Height, x.w, x.h)
			}
		}
	}
	if _, _, err := BackgroundImages(context.Background(), opener([]byte("not an image"))); err == nil {
		t.Fatal("garbage decoded")
	}
}
