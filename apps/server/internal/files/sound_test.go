package files

import (
	"bytes"
	"context"
	"encoding/binary"
	"math"
	"os/exec"
	"testing"
)

// oggPage builds one Ogg page with a single packet (≤ 255 bytes per lacing value).
func oggPage(granule int64, packet []byte) []byte {
	var segs []byte
	n := len(packet)
	for n >= 255 {
		segs = append(segs, 255)
		n -= 255
	}
	segs = append(segs, byte(n)) //nolint:gosec // < 255
	h := make([]byte, 27)
	copy(h, "OggS")
	binary.LittleEndian.PutUint64(h[6:14], uint64(granule)) //nolint:gosec // test data
	h[26] = byte(len(segs))                                 //nolint:gosec // test pages are small
	out := append(h, segs...)
	return append(out, packet...)
}

func opusHead(preSkip uint16) []byte {
	b := []byte("OpusHead\x01\x01\x00\x00\x80\xbb\x00\x00\x00\x00\x00")
	binary.LittleEndian.PutUint16(b[10:12], preSkip)
	return b
}

func TestOggOpusDurationMs(t *testing.T) {
	stream := append(oggPage(0, opusHead(312)), oggPage(0, []byte("OpusTags\x00\x00\x00\x00\x00\x00\x00\x00"))...)
	stream = append(stream, oggPage(24000+312, bytes.Repeat([]byte{1}, 300))...)
	stream = append(stream, oggPage(-1, []byte{2, 3})...) // a page where no packet ends
	stream = append(stream, oggPage(96000+312, []byte{4})...)
	if ms, ok := OggOpusDurationMs(stream); !ok || ms != 2000 {
		t.Fatalf("duration: %d %v", ms, ok)
	}
	for name, b := range map[string][]byte{
		"empty":      nil,
		"not ogg":    []byte("RIFF....WAVEfmt "),
		"truncated":  stream[:len(stream)-1],
		"trailing":   append(append([]byte{}, stream...), 'x'),
		"vorbis":     oggPage(0, []byte("\x01vorbis")),
		"pre-skip>g": append(oggPage(0, opusHead(5000)), oggPage(100, []byte{1})...),
	} {
		if _, ok := OggOpusDurationMs(b); ok {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestSniffAudio(t *testing.T) {
	for name, c := range map[string]struct {
		head []byte
		ok   bool
	}{
		"ogg":  {[]byte("OggS\x00\x02"), true},
		"id3":  {[]byte("ID3\x04\x00"), true},
		"mp3":  {[]byte{0xFF, 0xFB, 0x90, 0x44}, true},
		"wav":  {[]byte("RIFF\x24\x00\x00\x00WAVEfmt "), true},
		"avi":  {[]byte("RIFF\x24\x00\x00\x00AVI LIST"), false},
		"png":  {[]byte("\x89PNG\r\n\x1a\n"), false},
		"sync": {[]byte{0xFF, 0xE0}, false}, // reserved layer
		"none": {nil, false},
	} {
		if got := SniffAudio(c.head); got != c.ok {
			t.Errorf("%s: %v, want %v", name, got, c.ok)
		}
	}
}

// wav is a mono 16-bit PCM WAV of a 440 Hz tone.
func wav(seconds float64) []byte {
	const rate = 44100
	n := int(seconds * rate)
	data := make([]byte, 2*n)
	for i := range n {
		v := int16(math.Sin(2*math.Pi*440*float64(i)/rate) * 12000)
		binary.LittleEndian.PutUint16(data[2*i:], uint16(v)) //nolint:gosec // two's complement
	}
	var b bytes.Buffer
	b.WriteString("RIFF")
	_ = binary.Write(&b, binary.LittleEndian, uint32(36+len(data))) //nolint:gosec // small
	b.WriteString("WAVEfmt ")
	for _, v := range []any{uint32(16), uint16(1), uint16(1), uint32(rate), uint32(rate * 2), uint16(2), uint16(16)} {
		_ = binary.Write(&b, binary.LittleEndian, v)
	}
	b.WriteString("data")
	_ = binary.Write(&b, binary.LittleEndian, uint32(len(data))) //nolint:gosec // small
	b.Write(data)
	return b.Bytes()
}

// TestConvertSound runs the real ffmpeg (skipped without one): a WAV becomes an Ogg/Opus clip
// cut to 5 s; a file that only looks like audio is errBadAudio.
func TestConvertSound(t *testing.T) {
	ff, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("no ffmpeg on this host")
	}
	s := &Service{conv: &Converter{ffmpeg: ff, slot: make(chan struct{}, 1)}}
	for _, c := range []struct {
		seconds  float64
		min, max int64
	}{{1, 950, 1050}, {7, 4950, 5050}} {
		clip, err := s.convertSound(context.Background(), wav(c.seconds))
		if err != nil {
			t.Fatal(err)
		}
		ms, ok := OggOpusDurationMs(clip)
		if !ok || ms < c.min || ms > c.max || len(clip) > MaxSoundBytes {
			t.Fatalf("%.0f s: %d ms, ok=%v, %d bytes", c.seconds, ms, ok, len(clip))
		}
	}
	junk := append([]byte("RIFF\x24\x00\x00\x00WAVE"), bytes.Repeat([]byte{7}, 500)...)
	if _, err := s.convertSound(context.Background(), junk); !IsBadAudio(err) {
		t.Fatalf("junk: %v", err)
	}
}
