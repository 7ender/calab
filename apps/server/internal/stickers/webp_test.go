package stickers

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name)) //nolint:gosec // test fixture
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestValidateWebPFixtures(t *testing.T) {
	for _, tc := range []struct {
		file     string
		animated bool
		frames   int
	}{
		{"sun.webp", false, 1},  // lossy (VP8X + ALPH + VP8)
		{"gem.webp", false, 1},  // lossless (VP8L)
		{"orbit.webp", true, 6}, // animated (VP8X + ANIM + ANMF)
	} {
		info, err := ValidateWebP(fixture(t, tc.file))
		if err != nil {
			t.Fatalf("%s: %v", tc.file, err)
		}
		if info.Width != 160 || info.Height != 160 || info.Animated != tc.animated || info.Frames != tc.frames {
			t.Fatalf("%s: got %+v", tc.file, info)
		}
	}
	if info, _ := ValidateWebP(fixture(t, "orbit.webp")); info.DurationMs != 720 {
		t.Fatalf("duration: got %d", info.DurationMs)
	}
}

func riff(chunks ...[]byte) []byte {
	body := bytes.Join(chunks, nil)
	out := []byte("RIFF")
	out = binary.LittleEndian.AppendUint32(out, uint32(len(body)+4)) //nolint:gosec // test data
	out = append(out, "WEBP"...)
	return append(out, body...)
}

func ch(id string, payload []byte) []byte {
	out := append([]byte(id), binary.LittleEndian.AppendUint32(nil, uint32(len(payload)))...) //nolint:gosec // test data
	out = append(out, payload...)
	if len(payload)%2 == 1 {
		out = append(out, 0)
	}
	return out
}

// vp8l is a lossless bitstream header of w×h (the validator does not decode pixels).
func vp8l(w, h int) []byte {
	v := uint32(w-1) | uint32(h-1)<<14 //nolint:gosec // test data
	return append([]byte{0x2f}, binary.LittleEndian.AppendUint32(nil, v)...)
}

func vp8x(flags byte, w, h int) []byte {
	p := []byte{flags, 0, 0, 0}
	p = append(p, byte(w-1), byte((w-1)>>8), byte((w-1)>>16))    //nolint:gosec // test data, small sizes
	return append(p, byte(h-1), byte((h-1)>>8), byte((h-1)>>16)) //nolint:gosec // test data, small sizes
}

func le24(v int) []byte { return []byte{byte(v), byte(v >> 8), byte(v >> 16)} } //nolint:gosec // test data, small values

func anmf(x, y, w, h, dur int, data []byte) []byte {
	p := slices.Concat(le24(x/2), le24(y/2), le24(w-1), le24(h-1), le24(dur), []byte{0})
	return append(p, data...)
}

func TestValidateWebPRejects(t *testing.T) {
	good := riff(ch("VP8L", vp8l(100, 100)))
	if _, err := ValidateWebP(good); err != nil {
		t.Fatalf("minimal VP8L: %v", err)
	}
	gif := []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;")
	sizeLie := bytes.Clone(good)
	binary.LittleEndian.PutUint32(sizeLie[4:8], uint32(len(good))) //nolint:gosec // test data
	big := fixture(t, "big.webp")
	oversized := append(riff(ch("VP8L", vp8l(100, 100)), ch("XMP ", make([]byte, MaxStaticBytes))), nil...)
	frames := [][]byte{ch("VP8X", vp8x(flagAnimation, 64, 64)), ch("ANIM", make([]byte, 6))}
	for range MaxFrames + 1 {
		frames = append(frames, ch("ANMF", anmf(0, 0, 64, 64, 1, ch("VP8L", vp8l(64, 64)))))
	}
	for name, data := range map[string][]byte{
		"not riff":          gif,
		"html":              []byte("<html><script>alert(1)</script></html>"),
		"riff size lie":     sizeLie,
		"truncated":         good[:len(good)-2],
		"too large side":    big,
		"zero chunks":       riff(),
		"unknown chunk":     riff(ch("VP8L", vp8l(10, 10)), ch("JUNK", []byte{1, 2})),
		"two bitstreams":    riff(ch("VP8L", vp8l(10, 10)), ch("VP8L", vp8l(10, 10))),
		"bad vp8l sig":      riff(ch("VP8L", []byte{0x2e, 0, 0, 0, 0})),
		"bad vp8 start":     riff(ch("VP8 ", []byte{0, 0, 0, 1, 2, 3, 10, 0, 10, 0})),
		"canvas too large":  riff(ch("VP8X", vp8x(0, 513, 10)), ch("VP8L", vp8l(513, 10))),
		"canvas mismatch":   riff(ch("VP8X", vp8x(0, 20, 20)), ch("VP8L", vp8l(10, 10))),
		"reserved flag":     riff(ch("VP8X", vp8x(0x80, 10, 10)), ch("VP8L", vp8l(10, 10))),
		"anim no ANIM":      riff(ch("VP8X", vp8x(flagAnimation, 10, 10)), ch("ANMF", anmf(0, 0, 10, 10, 100, ch("VP8L", vp8l(10, 10))))),
		"anim no frames":    riff(ch("VP8X", vp8x(flagAnimation, 10, 10)), ch("ANIM", make([]byte, 6))),
		"frame off canvas":  riff(ch("VP8X", vp8x(flagAnimation, 10, 10)), ch("ANIM", make([]byte, 6)), ch("ANMF", anmf(4, 0, 10, 10, 100, ch("VP8L", vp8l(10, 10))))),
		"frame junk":        riff(ch("VP8X", vp8x(flagAnimation, 10, 10)), ch("ANIM", make([]byte, 6)), ch("ANMF", anmf(0, 0, 10, 10, 100, ch("JUNK", []byte{1, 2})))),
		"too long":          riff(ch("VP8X", vp8x(flagAnimation, 10, 10)), ch("ANIM", make([]byte, 6)), ch("ANMF", anmf(0, 0, 10, 10, MaxDurationMs+1, ch("VP8L", vp8l(10, 10))))),
		"too many frames":   riff(frames...),
		"static over limit": oversized,
		"chunk past end":    append(riff(ch("VP8L", vp8l(10, 10)))[:12], []byte("VP8L\xff\xff\x00\x00\x2f")...),
	} {
		if _, err := ValidateWebP(data); err == nil || !IsInvalidWebP(err) {
			t.Errorf("%s: expected a WebP rejection, got %v", name, err)
		}
	}
}
