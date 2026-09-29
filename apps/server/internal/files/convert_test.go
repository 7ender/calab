package files

import (
	"bytes"
	"context"
	"image"
	"image/jpeg"
	"os"
	"strings"
	"testing"
	"time"
)

// Fixtures (testdata/, made with macOS ImageIO like an iPhone photo): grid.heic — a 1030×530
// tile grid (3×2 tiles of 512), left half red, right half blue; grid-rot6.heic — the same pixels
// with EXIF orientation 6 (irot = 3: shown 90° clockwise, red on top); single.heic — one
// 64×48 image item.

func TestIsHEIF(t *testing.T) {
	grid, err := os.ReadFile("testdata/grid.heic")
	if err != nil {
		t.Fatal(err)
	}
	ftyp := func(brands ...string) []byte {
		b := []byte{0, 0, 0, byte(8 + 4*len(brands)), 'f', 't', 'y', 'p'} //nolint:gosec // a few brands
		for _, s := range brands {
			b = append(b, s...)
		}
		return append(b, make([]byte, 16)...)
	}
	for _, c := range []struct {
		name string
		head []byte
		want bool
	}{
		{"apple heic", grid[:64], true},
		{"heix", ftyp("heix", "\x00\x00\x00\x00", "mif1"), true},
		{"generic mif1", ftyp("mif1", "\x00\x00\x00\x00", "mif1"), true},
		{"avif", ftyp("avif", "\x00\x00\x00\x00", "mif1", "avif"), false},
		{"mp4", ftyp("isom", "\x00\x00\x02\x00", "isom", "mp41"), false},
		{"jpeg", []byte("\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01"), false},
		{"short", []byte("\x00\x00\x00\x18ftypheic"), false},
	} {
		if got := IsHEIF(c.head); got != c.want {
			t.Errorf("%s: IsHEIF = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestHEIFOrientation(t *testing.T) {
	for _, c := range []struct {
		file string
		want string
	}{
		{"testdata/grid.heic", ""},
		{"testdata/grid-rot6.heic", "transpose=clock"},
		{"testdata/single.heic", ""},
	} {
		f, err := os.Open(c.file)
		if err != nil {
			t.Fatal(err)
		}
		st, _ := f.Stat()
		got, err := heifOrientation(f, st.Size())
		_ = f.Close()
		if err != nil {
			t.Fatalf("%s: %v", c.file, err)
		}
		if strings.Join(got, ",") != c.want {
			t.Errorf("%s: filters %q, want %q", c.file, got, c.want)
		}
	}
	// Not ISO-BMFF at all: no filters, no panic.
	if got, err := heifOrientation(bytes.NewReader([]byte("garbage-garbage")), 15); len(got) != 0 {
		t.Fatalf("garbage: %v %v", got, err)
	}
}

func TestBuildGraph(t *testing.T) {
	var p probeInfo
	p.StreamGroups = append(p.StreamGroups, struct {
		Type        string `json:"type"`
		Disposition struct {
			Default int `json:"default"`
		} `json:"disposition"`
		Components []tileGrid `json:"components"`
	}{Type: "Tile Grid"})
	g := tileGrid{Width: 1030, Height: 530}
	for i, xy := range [][2]int{{0, 0}, {512, 0}, {1024, 0}, {0, 512}, {512, 512}, {1024, 512}} {
		g.Subcomponents = append(g.Subcomponents, struct {
			StreamIndex int `json:"stream_index"`
			X           int `json:"tile_horizontal_offset"`
			Y           int `json:"tile_vertical_offset"`
		}{i, xy[0], xy[1]})
	}
	p.StreamGroups[0].Components = []tileGrid{g}
	got, err := buildGraph(p, []string{"transpose=clock"})
	if err != nil {
		t.Fatal(err)
	}
	want := "[0:0][0:1][0:2][0:3][0:4][0:5]xstack=inputs=6:layout=0_0|512_0|1024_0|0_512|512_512|1024_512,crop=1030:530:0:0," +
		"transpose=clock,scale=w='min(4096,iw)':h='min(4096,ih)':force_original_aspect_ratio=decrease[out]"
	if got != want {
		t.Fatalf("graph\n got %s\nwant %s", got, want)
	}
	if _, err := buildGraph(probeInfo{}, nil); err == nil {
		t.Fatal("no streams: want an error")
	}
}

// The real ffmpeg on this machine / CI runner decodes the fixtures (skipped without
// ffmpeg ≥ 7.1: the endpoint then answers 501 and clients show «HEIC не поддерживается»).
func TestConverterToJPEG(t *testing.T) {
	c := NewConverter(context.Background(), "ffmpeg", "ffprobe")
	if c == nil {
		t.Skip("ffmpeg/ffprobe ≥ 7.1 not found: HEIC conversion is not tested here")
	}
	type px struct{ x, y int }
	for _, tc := range []struct {
		file      string
		w, h      int
		red, blue px
	}{
		{"testdata/grid.heic", 1030, 530, px{100, 265}, px{930, 265}},
		{"testdata/grid-rot6.heic", 530, 1030, px{265, 100}, px{265, 930}},
		{"testdata/single.heic", 64, 48, px{-1, -1}, px{-1, -1}},
	} {
		f, err := os.Open(tc.file)
		if err != nil {
			t.Fatal(err)
		}
		st, _ := f.Stat()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		out, err := c.ToJPEG(ctx, f, st.Size())
		cancel()
		_ = f.Close()
		if err != nil {
			t.Fatalf("%s: %v", tc.file, err)
		}
		img, err := jpeg.Decode(bytes.NewReader(out))
		if err != nil {
			t.Fatalf("%s: not a JPEG: %v", tc.file, err)
		}
		if b := img.Bounds(); b.Dx() != tc.w || b.Dy() != tc.h {
			t.Fatalf("%s: %dx%d, want %dx%d", tc.file, b.Dx(), b.Dy(), tc.w, tc.h)
		}
		if tc.red.x >= 0 {
			if !isColor(img, tc.red, 'r') || !isColor(img, tc.blue, 'b') {
				t.Fatalf("%s: tiles misplaced (red at %v, blue at %v expected)", tc.file, tc.red, tc.blue)
			}
		}
	}
}

func isColor(img image.Image, p struct{ x, y int }, c byte) bool {
	r, g, b, _ := img.At(p.x, p.y).RGBA()
	r, g, b = r>>8, g>>8, b>>8
	if c == 'r' {
		return r > 180 && g < 80 && b < 80
	}
	return b > 180 && r < 80 && g < 80
}
