package files

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/httpx"
)

// HEIC → JPEG for clients that cannot decode it (docs/02 «Изображения: клиентское сжатие и
// HEIC»): Chromium has no HEIF decoder, so the web client and Electron on Linux / Windows
// without the HEIF codec send the picture here and upload the JPEG they get back. Nothing is
// stored. One conversion at a time (ffmpeg decodes a 12 MP grid in ~0.5 s and ~200 MB), 20 s
// for waiting plus converting.
const (
	MaxConvertBytes = 25 << 20
	convertTimeout  = 20 * time.Second
	convertMaxSide  = 4096
	maxConvertOut   = 16 << 20
)

var (
	errConvertUnavailable = httpx.Coded(http.StatusNotImplemented, v1.ErrorCode_ERROR_CODE_UNAVAILABLE, "image conversion is not available on this server")
	errConvertBusy        = httpx.Coded(http.StatusServiceUnavailable, v1.ErrorCode_ERROR_CODE_UNAVAILABLE, "image conversion is busy, try again")
	errNotHEIF            = httpx.Coded(http.StatusUnsupportedMediaType, v1.ErrorCode_ERROR_CODE_VALIDATION, "file must be a HEIC/HEIF image")
)

// Converter runs ffmpeg / ffprobe (FFMPEG_PATH / FFPROBE_PATH); a nil or disabled Converter
// answers 501 and the client shows «HEIC не поддерживается».
type Converter struct {
	ffmpeg, ffprobe string
	slot            chan struct{}
}

// ffmpegMin is the first ffmpeg that demuxes HEIF tile grids (7.1).
var ffmpegVersion = regexp.MustCompile(`ffmpeg version n?(\d+)\.(\d+)`)

// NewConverter resolves the binaries and checks the ffmpeg version (≥ 7.1: HEIF tile grids);
// nil when conversion is unavailable (logged once).
func NewConverter(ctx context.Context, ffmpeg, ffprobe string) *Converter {
	fp, err1 := exec.LookPath(ffmpeg)
	pp, err2 := exec.LookPath(ffprobe)
	if err1 != nil || err2 != nil {
		slog.InfoContext(ctx, "HEIC conversion disabled: ffmpeg / ffprobe not found", "ffmpeg", ffmpeg, "ffprobe", ffprobe)
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, fp, "-hide_banner", "-version").Output() //nolint:gosec // FFMPEG_PATH is operator config
	if err != nil {
		slog.WarnContext(ctx, "HEIC conversion disabled: ffmpeg -version failed", "err", err)
		return nil
	}
	if m := ffmpegVersion.FindSubmatch(out); m != nil {
		major, _ := strconv.Atoi(string(m[1]))
		minor, _ := strconv.Atoi(string(m[2]))
		if major < 7 || (major == 7 && minor < 1) {
			slog.WarnContext(ctx, "HEIC conversion disabled: ffmpeg ≥ 7.1 required", "version", string(m[0]))
			return nil
		}
	} // a git build ("ffmpeg version N-…") is taken as recent
	return &Converter{ffmpeg: fp, ffprobe: pp, slot: make(chan struct{}, 1)}
}

// SetConverter enables POST /api/files/convert (nil: 501).
func (s *Service) SetConverter(c *Converter) { s.conv = c }

// convert: POST /api/files/convert?to=jpeg — multipart "file" (HEIC/HEIF ≤ 25 MB) → the
// picture as JPEG ≤ 4096 px on the longer side, orientation applied, metadata stripped.
func (s *Service) convert(w http.ResponseWriter, r *http.Request) error {
	if to := r.URL.Query().Get("to"); to != "jpeg" {
		return httpx.Validation("to", "only to=jpeg is supported")
	}
	uid := auth.MustFromContext(r.Context()).UserID
	if s.limiter != nil {
		if err := s.limiter.Take(r.Context(), uid.String()); err != nil {
			return err
		}
	}
	if r.ContentLength > MaxConvertBytes+1<<20 {
		return tooLarge(MaxConvertBytes)
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(2 * time.Minute))
	r.Body = http.MaxBytesReader(w, r.Body, MaxConvertBytes+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		return httpx.BadRequest("expected multipart/form-data with a \"file\" field")
	}
	var part io.ReadCloser
	for i := 0; ; i++ {
		p, err := mr.NextPart()
		if err != nil || i > 8 {
			return httpx.BadRequest("multipart field \"file\" not found")
		}
		if p.FormName() == "file" {
			part = p
			break
		}
		_ = p.Close()
	}
	defer func() { _ = part.Close() }()
	br := bufio.NewReaderSize(part, 4096)
	head, _ := br.Peek(64)
	if !IsHEIF(head) {
		return errNotHEIF
	}
	tmp, err := os.CreateTemp("", "calaba-convert-*.heic")
	if err != nil {
		return err
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	n, err := io.Copy(tmp, io.LimitReader(br, MaxConvertBytes+1))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return tooLarge(MaxConvertBytes)
		}
		return fmt.Errorf("convert: buffer upload: %w", err)
	}
	if n > MaxConvertBytes {
		return tooLarge(MaxConvertBytes)
	}
	if s.conv == nil {
		return errConvertUnavailable
	}
	ctx, cancel := context.WithTimeout(r.Context(), convertTimeout)
	defer cancel()
	jpeg, err := s.conv.ToJPEG(ctx, tmp, n)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Content-Length", strconv.Itoa(len(jpeg)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(jpeg)
	return nil
}

// probeInfo is the part of `ffprobe -show_stream_groups -show_streams -of json` we use.
type probeInfo struct {
	Streams []struct {
		Index       int    `json:"index"`
		CodecType   string `json:"codec_type"`
		Disposition struct {
			Default   int `json:"default"`
			Dependent int `json:"dependent"`
		} `json:"disposition"`
	} `json:"streams"`
	StreamGroups []struct {
		Type        string `json:"type"`
		Disposition struct {
			Default int `json:"default"`
		} `json:"disposition"`
		Components []tileGrid `json:"components"`
	} `json:"stream_groups"`
}

type tileGrid struct {
	HorizontalOffset int `json:"horizontal_offset"`
	VerticalOffset   int `json:"vertical_offset"`
	Width            int `json:"width"`
	Height           int `json:"height"`
	Subcomponents    []struct {
		StreamIndex int `json:"stream_index"`
		X           int `json:"tile_horizontal_offset"`
		Y           int `json:"tile_vertical_offset"`
	} `json:"subcomponents"`
}

// buildGraph is the -filter_complex that assembles the primary picture (a tile grid is
// stacked and cropped; ffmpeg's CLI takes only its first tile), applies the orientation and
// fits it within convertMaxSide.
func buildGraph(p probeInfo, orient []string) (string, error) {
	var src string
	var grid *tileGrid
	for i := range p.StreamGroups {
		g := &p.StreamGroups[i]
		if g.Type != "Tile Grid" || len(g.Components) == 0 {
			continue
		}
		if grid == nil || g.Disposition.Default == 1 {
			grid = &g.Components[0]
		}
		if g.Disposition.Default == 1 {
			break
		}
	}
	switch {
	case grid != nil && len(grid.Subcomponents) > 1:
		if grid.Width <= 0 || grid.Height <= 0 || len(grid.Subcomponents) > 1024 {
			return "", errors.New("bad tile grid")
		}
		var in, layout strings.Builder
		for i, t := range grid.Subcomponents {
			fmt.Fprintf(&in, "[0:%d]", t.StreamIndex)
			if i > 0 {
				layout.WriteByte('|')
			}
			fmt.Fprintf(&layout, "%d_%d", t.X, t.Y)
		}
		src = fmt.Sprintf("%sxstack=inputs=%d:layout=%s,crop=%d:%d:%d:%d", in.String(), len(grid.Subcomponents), layout.String(),
			grid.Width, grid.Height, grid.HorizontalOffset, grid.VerticalOffset)
	case grid != nil && len(grid.Subcomponents) == 1:
		src = fmt.Sprintf("[0:%d]null", grid.Subcomponents[0].StreamIndex)
	default:
		pick := -1
		for _, st := range p.Streams {
			if st.CodecType != "video" || st.Disposition.Dependent == 1 {
				continue
			}
			if pick < 0 || st.Disposition.Default == 1 {
				pick = st.Index
			}
			if st.Disposition.Default == 1 {
				break
			}
		}
		if pick < 0 {
			return "", errors.New("no picture")
		}
		src = fmt.Sprintf("[0:%d]null", pick)
	}
	chain := append([]string{src}, orient...)
	chain = append(chain, fmt.Sprintf("scale=w='min(%d,iw)':h='min(%d,ih)':force_original_aspect_ratio=decrease", convertMaxSide, convertMaxSide))
	return strings.Join(chain, ",") + "[out]", nil
}

// ToJPEG converts the HEIF file f (size bytes) within ctx, waiting for the single slot.
func (c *Converter) ToJPEG(ctx context.Context, f *os.File, size int64) ([]byte, error) {
	select {
	case c.slot <- struct{}{}:
		defer func() { <-c.slot }()
	case <-ctx.Done():
		return nil, errConvertBusy
	}
	undecodable := httpx.Validation("file", "the image cannot be decoded")
	orient, err := heifOrientation(f, size)
	if err != nil {
		orient = nil // shown as stored
	}
	var probe probeInfo
	out, err := exec.CommandContext(ctx, c.ffprobe, "-v", "error", "-show_stream_groups", "-show_streams", //nolint:gosec // operator-configured binary, temp file path
		"-of", "json", f.Name()).Output()
	if ctx.Err() != nil {
		return nil, errConvertBusy
	}
	if err != nil || json.Unmarshal(out, &probe) != nil {
		return nil, undecodable
	}
	graph, err := buildGraph(probe, orient)
	if err != nil {
		return nil, undecodable
	}
	cmd := exec.CommandContext(ctx, c.ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", //nolint:gosec // operator-configured binary, fixed args
		"-noautorotate", "-i", f.Name(), "-filter_complex", graph, "-map", "[out]",
		"-frames:v", "1", "-map_metadata", "-1", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "pipe:1")
	var stdout, stderr capBuffer
	stdout.max, stderr.max = maxConvertOut, 4096
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err = cmd.Run()
	if ctx.Err() != nil {
		return nil, errConvertBusy
	}
	jpeg := stdout.Bytes()
	if err != nil || stdout.over || !bytes.HasPrefix(jpeg, []byte{0xff, 0xd8, 0xff}) {
		slog.InfoContext(ctx, "HEIC conversion failed", "err", err, "stderr", stderr.String())
		return nil, undecodable
	}
	return jpeg, nil
}

// capBuffer keeps at most max bytes (and remembers that more came).
type capBuffer struct {
	bytes.Buffer
	max  int
	over bool
}

func (b *capBuffer) Write(p []byte) (int, error) {
	if room := b.max - b.Len(); len(p) > room {
		b.over = true
		if room > 0 {
			b.Buffer.Write(p[:room])
		}
		return len(p), nil
	}
	return b.Buffer.Write(p)
}
