package files

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Soundboard clips of a workspace (ADR-0036): the server makes the clip itself from the admin's
// upload (MP3, Ogg or WAV, ≤ MaxSoundSourceBytes) with ffmpeg — Ogg/Opus 48 kHz mono, loudness
// normalised to −16 LUFS, cut to MaxSoundMs — so every clip plays the same way on every client
// and at a similar volume.
const (
	MaxSoundSourceBytes = 2 << 20
	MaxSoundMs          = 5000
	MaxSoundBytes       = 200 << 10 // 5 s at 96 kbit/s is ~60 KB; far above any real clip
	SoundMime           = "audio/ogg"
	soundTimeout        = 20 * time.Second
	soundBitrate        = "96k"
)

var (
	errBadAudio = errors.New("files: not a readable MP3, Ogg or WAV clip")
	// ErrNoFFmpeg means FFMPEG_PATH does not name a runnable ffmpeg: sounds cannot be added.
	ErrNoFFmpeg = errors.New("files: ffmpeg is not available")
)

// IsBadAudio reports a source that is not a usable audio file (422, not a server error).
func IsBadAudio(err error) bool { return errors.Is(err, errBadAudio) }

// One conversion at a time bounds CPU and memory: sounds are added rarely and take ~0.2 s.
var soundSlot = make(chan struct{}, 1)

// SetFFmpeg sets the ffmpeg binary (FFMPEG_PATH): a path, or a name looked up in PATH. An
// empty or missing one leaves sounds unavailable (ErrNoFFmpeg).
func (s *Service) SetFFmpeg(path string) {
	s.ffmpeg = ""
	if path == "" {
		return
	}
	if p, err := exec.LookPath(path); err == nil {
		s.ffmpeg = p
	}
}

// HasFFmpeg reports whether sounds can be converted.
func (s *Service) HasFFmpeg() bool { return s.ffmpeg != "" }

// SniffAudio reports whether head starts an Ogg stream, a RIFF/WAVE file or an MP3 (an ID3v2
// tag or an MPEG audio frame sync). It is a cheap filter before ffmpeg, not a validation.
func SniffAudio(head []byte) bool {
	switch {
	case bytes.HasPrefix(head, []byte("OggS")), bytes.HasPrefix(head, []byte("ID3")):
		return true
	case len(head) >= 12 && bytes.HasPrefix(head, []byte("RIFF")) && bytes.Equal(head[8:12], []byte("WAVE")):
		return true
	case len(head) >= 2 && head[0] == 0xFF && head[1]&0xE0 == 0xE0 && head[1]&0x06 != 0: // frame sync, a layer
		return true
	}
	return false
}

// OggOpusDurationMs is the playing time of an Ogg/Opus stream: the granule position of its last
// page minus the pre-skip of the ID header, at 48 kHz. ok=false for anything else.
func OggOpusDurationMs(b []byte) (ms int64, ok bool) {
	if !IsOggOpus(b) {
		return 0, false
	}
	first := 27 + int(b[26])
	if len(b) < first+12 {
		return 0, false
	}
	preSkip := int64(binary.LittleEndian.Uint16(b[first+10 : first+12]))
	last := int64(-1)
	for off := 0; off < len(b); {
		if len(b)-off < 27 || !bytes.Equal(b[off:off+4], []byte("OggS")) {
			return 0, false
		}
		segs := int(b[off+26])
		if len(b)-off < 27+segs {
			return 0, false
		}
		body := 0
		for _, l := range b[off+27 : off+27+segs] {
			body += int(l)
		}
		if g := int64(binary.LittleEndian.Uint64(b[off+6 : off+14])); g >= 0 { //nolint:gosec // -1 = no packet ends here
			last = g
		}
		off += 27 + segs + body
		if off > len(b) {
			return 0, false
		}
	}
	if last < preSkip {
		return 0, false
	}
	return (last - preSkip) * 1000 / 48000, true
}

// SoundArgs are the ffmpeg arguments that turn in into the clip out: at most MaxSoundMs of the
// first audio stream, mono 48 kHz, EBU R128 loudness −16 LUFS (true peak −1.5 dBTP), Opus in
// Ogg without metadata.
func SoundArgs(in, out string) []string {
	return []string{
		"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-t", "5", "-i", in,
		"-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
		"-af", "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000",
		"-ac", "1", "-ar", "48000",
		"-c:a", "libopus", "-b:a", soundBitrate, "-application", "audio",
		"-f", "ogg", out,
	}
}

// PrepareSound makes the clip of the audio file src (a workspace file; the caller checked who
// may use it) and stores it as a new file of that workspace. A source that ffmpeg cannot read,
// or that gives no sound, is IsBadAudio; without ffmpeg the error is ErrNoFFmpeg.
func (s *Service) PrepareSound(ctx context.Context, src sqlc.File) (*PreparedFile, int32, error) {
	if src.WorkspaceID == nil || src.Size > MaxSoundSourceBytes {
		return nil, 0, errBadAudio
	}
	if s.ffmpeg == "" {
		return nil, 0, ErrNoFFmpeg
	}
	rc, _, err := s.store.Get(ctx, src.Key)
	if err != nil {
		return nil, 0, err
	}
	data, err := io.ReadAll(io.LimitReader(rc, MaxSoundSourceBytes+1))
	_ = rc.Close()
	if err != nil {
		return nil, 0, err
	}
	if len(data) > MaxSoundSourceBytes || !SniffAudio(data) {
		return nil, 0, errBadAudio
	}
	clip, err := s.convertSound(ctx, data)
	if err != nil {
		return nil, 0, err
	}
	ms, ok := OggOpusDurationMs(clip)
	if !ok || ms < 1 || len(clip) > MaxSoundBytes {
		return nil, 0, errBadAudio
	}
	ms = min(ms, MaxSoundMs) // the last Opus frame may run a few ms past the cut
	id, err := uuid.NewV7()
	if err != nil {
		return nil, 0, err
	}
	sum := sha256.Sum256(clip)
	st := &stored{id: id, key: blob.FileKey(*src.WorkspaceID, id), name: "sound.ogg", mime: SoundMime,
		size: int64(len(clip)), sha256: hex.EncodeToString(sum[:])}
	if err := s.store.Put(ctx, st.key, bytes.NewReader(clip), st.size, SoundMime); err != nil {
		return nil, 0, fmt.Errorf("store sound: %w", err)
	}
	return &PreparedFile{st: st, workspaceID: *src.WorkspaceID, uploader: src.UploaderID}, int32(ms), nil //nolint:gosec // ≤ MaxSoundMs
}

// convertSound runs ffmpeg on data in a private temp dir, in the single conversion slot, within
// soundTimeout. A failing conversion is errBadAudio (the input is what fails, as a rule).
func (s *Service) convertSound(ctx context.Context, data []byte) ([]byte, error) {
	select {
	case soundSlot <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-soundSlot }()
	dir, err := os.MkdirTemp("", "calaba-sound-")
	if err != nil {
		return nil, err
	}
	defer func() { _ = os.RemoveAll(dir) }()
	in, out := filepath.Join(dir, "in"), filepath.Join(dir, "out.ogg")
	if err := os.WriteFile(in, data, 0o600); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, soundTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, s.ffmpeg, SoundArgs(in, out)...) //nolint:gosec // FFMPEG_PATH is operator configuration
	cmd.Dir = dir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%w: ffmpeg: %v: %s", errBadAudio, err, bytes.TrimSpace(stderr.Bytes()[:min(stderr.Len(), 300)]))
	}
	clip, err := os.ReadFile(out) //nolint:gosec // our temp dir
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errBadAudio, err)
	}
	return clip, nil
}
