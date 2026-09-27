package stickers

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

// checkInvariants: ValidateWebP never panics; an accepted file obeys every limit.
func checkInvariants(t *testing.T, data []byte) {
	t.Helper()
	info, err := ValidateWebP(data)
	if err != nil {
		if !IsInvalidWebP(err) {
			t.Fatalf("rejection is not an invalid-WebP error: %v", err)
		}
		return
	}
	limit := MaxStaticBytes
	if info.Animated {
		limit = MaxAnimatedBytes
	}
	if info.Width < 1 || info.Height < 1 || info.Width > MaxSide || info.Height > MaxSide ||
		info.Frames < 1 || info.Frames > MaxFrames || info.DurationMs > MaxDurationMs || len(data) > limit {
		t.Fatalf("accepted a file outside the limits: %+v (%d bytes)", info, len(data))
	}
}

// hostile returns corrupted variants of a valid file: every prefix (truncation), chunk and
// RIFF sizes set to huge / off-by-one values, every byte of the headers flipped.
func hostile(data []byte) [][]byte {
	var out [][]byte
	for n := 0; n < len(data); n++ {
		out = append(out, data[:n])
	}
	for _, v := range []uint32{0, 1, 0x7fffffff, 0xfffffff7, 0xffffffff} {
		for off := 4; off+4 <= len(data) && off < 64; off += 2 {
			b := append([]byte(nil), data...)
			binary.LittleEndian.PutUint32(b[off:], v)
			out = append(out, b)
		}
	}
	for i := 0; i < len(data) && i < 64; i++ {
		b := append([]byte(nil), data...)
		b[i] ^= 0xff
		out = append(out, b)
	}
	return out
}

func TestValidateWebPHostile(t *testing.T) {
	for _, name := range []string{"sun.webp", "gem.webp", "orbit.webp", "big.webp"} {
		for _, b := range hostile(fixture(t, name)) {
			checkInvariants(t, b)
		}
	}
	// Truncated prefixes of a valid file are never accepted.
	orbit := fixture(t, "orbit.webp")
	for n := 0; n < len(orbit)-1; n++ {
		if _, err := ValidateWebP(orbit[:n]); err == nil {
			t.Fatalf("accepted a %d-byte prefix", n)
		}
	}
	// A huge declared canvas / frame count is rejected from the headers alone.
	huge := riff(vp8x(flagAnimation, 1<<24-1, 1<<24-1), ch("ANIM", make([]byte, 6)))
	if _, err := ValidateWebP(huge); err == nil {
		t.Fatal("accepted a 16M×16M canvas")
	}
}

// FuzzValidateWebP: go test -fuzz=FuzzValidateWebP ./internal/stickers (seeds run in the
// normal test pass).
func FuzzValidateWebP(f *testing.F) {
	for _, name := range []string{"sun.webp", "gem.webp", "orbit.webp", "big.webp"} {
		b, err := os.ReadFile(filepath.Join("testdata", name)) //nolint:gosec // test fixture
		if err != nil {
			f.Fatal(err)
		}
		f.Add(b)
		f.Add(b[:len(b)/2])
	}
	f.Add([]byte("RIFF\xff\xff\xff\xffWEBPVP8X\xff\xff\xff\xff"))
	f.Add(riff(ch("VP8L", []byte{0x2f, 0xff, 0xff, 0xff, 0x0f})))
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 2*MaxAnimatedBytes {
			return
		}
		checkInvariants(t, data)
	})
}
