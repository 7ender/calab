package stickers

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
)

// WebP limits of a sticker (ADR-0030 §6).
const (
	MaxSide          = 512
	MaxStaticBytes   = 512 << 10
	MaxAnimatedBytes = 1 << 20
	MaxFrames        = 300
	MaxDurationMs    = 10_000
)

// WebPInfo is what the validator learned about a WebP file.
type WebPInfo struct {
	Width, Height int
	Animated      bool
	Frames        int
	DurationMs    int
}

var errWebP = errors.New("not a valid WebP sticker")

func bad(format string, args ...any) error {
	return fmt.Errorf("%w: %s", errWebP, fmt.Sprintf(format, args...))
}

// IsInvalidWebP reports a ValidateWebP rejection.
func IsInvalidWebP(err error) bool { return errors.Is(err, errWebP) }

type chunk struct {
	id      string
	payload []byte
}

// chunks splits a sequence of RIFF chunks (4-byte FourCC, little-endian uint32 size, payload,
// a pad byte after an odd size). Every chunk must lie within data.
func chunks(data []byte) ([]chunk, error) {
	var out []chunk
	for off := 0; off < len(data); {
		if len(data)-off < 8 {
			return nil, bad("truncated chunk header")
		}
		id := string(data[off : off+4])
		size := binary.LittleEndian.Uint32(data[off+4 : off+8])
		off += 8
		if int64(size) > int64(len(data)-off) {
			return nil, bad("chunk %q exceeds the file", id)
		}
		out = append(out, chunk{id: id, payload: data[off : off+int(size)]})
		off += int(size)
		if size%2 == 1 {
			if off >= len(data) {
				// A missing pad byte at the very end is tolerated by decoders.
				break
			}
			off++
		}
	}
	return out, nil
}

func u24(b []byte) int { return int(b[0]) | int(b[1])<<8 | int(b[2])<<16 }

// bitstreamSize returns the dimensions of a VP8 (lossy) or VP8L (lossless) bitstream.
func bitstreamSize(c chunk) (int, int, error) {
	p := c.payload
	switch c.id {
	case "VP8 ":
		// 3-byte frame tag (a key frame has bit 0 clear), start code 9d 01 2a, 14-bit sizes.
		if len(p) < 10 || p[0]&1 != 0 || !bytes.Equal(p[3:6], []byte{0x9d, 0x01, 0x2a}) {
			return 0, 0, bad("malformed VP8 bitstream")
		}
		w := int(binary.LittleEndian.Uint16(p[6:8]) & 0x3fff)
		h := int(binary.LittleEndian.Uint16(p[8:10]) & 0x3fff)
		return w, h, nil
	case "VP8L":
		// Signature 0x2f, then 14-bit width-1, 14-bit height-1, alpha bit, 3-bit version 0.
		if len(p) < 5 || p[0] != 0x2f {
			return 0, 0, bad("malformed VP8L bitstream")
		}
		v := binary.LittleEndian.Uint32(p[1:5])
		if v>>29 != 0 {
			return 0, 0, bad("unsupported VP8L version")
		}
		return int(v&0x3fff) + 1, int((v>>14)&0x3fff) + 1, nil
	}
	return 0, 0, bad("unexpected chunk %q", c.id)
}

// imageData checks the image chunks of a still image or of one animation frame: an optional
// ALPH (only before a lossy VP8) and exactly one VP8 / VP8L of the given size.
func imageData(cs []chunk, w, h int) error {
	var alpha bool
	for i, c := range cs {
		switch c.id {
		case "ALPH":
			if alpha || i != 0 {
				return bad("misplaced ALPH chunk")
			}
			alpha = true
		case "VP8 ", "VP8L":
			if i != len(cs)-1 {
				return bad("extra chunks after the bitstream")
			}
			if alpha && c.id == "VP8L" {
				return bad("ALPH before a lossless bitstream")
			}
			bw, bh, err := bitstreamSize(c)
			if err != nil {
				return err
			}
			if bw != w || bh != h {
				return bad("bitstream size %dx%d does not match %dx%d", bw, bh, w, h)
			}
			return nil
		default:
			return bad("unexpected chunk %q in image data", c.id)
		}
	}
	return bad("no image bitstream")
}

// ValidateWebP parses the container of a WebP file without decoding pixels (ADR-0030 §7):
// RIFF size equal to the file, the "WEBP" form, known chunks only, lengths within the file,
// sides 1..MaxSide, and for an animation: the VP8X animation flag, one ANIM before the
// frames, 1..MaxFrames ANMF frames inside the canvas, at most MaxDurationMs in total.
// The per-kind byte limits (MaxStaticBytes / MaxAnimatedBytes) are checked too.
func ValidateWebP(data []byte) (WebPInfo, error) {
	var info WebPInfo
	if len(data) < 20 || string(data[0:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return info, bad("missing RIFF/WEBP signature")
	}
	riff := binary.LittleEndian.Uint32(data[4:8])
	if uint64(riff)+8 != uint64(len(data)) {
		return info, bad("RIFF size %d does not match the file (%d bytes)", riff, len(data))
	}
	cs, err := chunks(data[12:])
	if err != nil {
		return info, err
	}
	if len(cs) == 0 {
		return info, bad("no chunks")
	}
	switch cs[0].id {
	case "VP8 ", "VP8L":
		if len(cs) != 1 {
			return info, bad("a simple WebP has one chunk")
		}
		if info.Width, info.Height, err = bitstreamSize(cs[0]); err != nil {
			return info, err
		}
		info.Frames = 1
	case "VP8X":
		if err := extended(cs, &info); err != nil {
			return info, err
		}
	default:
		return info, bad("unexpected first chunk %q", cs[0].id)
	}
	if info.Width < 1 || info.Height < 1 || info.Width > MaxSide || info.Height > MaxSide {
		return info, bad("size %dx%d is outside 1..%d", info.Width, info.Height, MaxSide)
	}
	limit := MaxStaticBytes
	if info.Animated {
		limit = MaxAnimatedBytes
	}
	if len(data) > limit {
		return info, bad("file is larger than %d KB", limit>>10)
	}
	return info, nil
}

// VP8X feature flags.
const (
	flagAnimation = 0x02
	flagXMP       = 0x04
	flagEXIF      = 0x08
	flagAlpha     = 0x10
	flagICC       = 0x20
)

func extended(cs []chunk, info *WebPInfo) error {
	x := cs[0].payload
	if len(x) != 10 {
		return bad("VP8X chunk must be 10 bytes")
	}
	flags := x[0]
	if flags&^(flagAnimation|flagXMP|flagEXIF|flagAlpha|flagICC) != 0 {
		return bad("reserved VP8X flags set")
	}
	info.Width, info.Height = u24(x[4:7])+1, u24(x[7:10])+1
	if info.Width > MaxSide || info.Height > MaxSide {
		return bad("canvas %dx%d is larger than %d", info.Width, info.Height, MaxSide)
	}
	info.Animated = flags&flagAnimation != 0
	rest := cs[1:]
	var image []chunk
	seenANIM := false
	for i, c := range rest {
		switch c.id {
		case "ICCP":
			if i != 0 || flags&flagICC == 0 {
				return bad("misplaced ICCP chunk")
			}
		case "EXIF", "XMP ":
			// Metadata; allowed anywhere after the image data.
		case "ANIM":
			if !info.Animated || seenANIM || info.Frames > 0 {
				return bad("unexpected ANIM chunk")
			}
			if len(c.payload) != 6 {
				return bad("ANIM chunk must be 6 bytes")
			}
			seenANIM = true
		case "ANMF":
			if !seenANIM {
				return bad("ANMF without a preceding ANIM")
			}
			if err := frame(c.payload, info); err != nil {
				return err
			}
		case "ALPH", "VP8 ", "VP8L":
			if info.Animated {
				return bad("image chunk %q outside a frame of an animation", c.id)
			}
			image = append(image, c)
		default:
			return bad("unknown chunk %q", c.id)
		}
	}
	if info.Animated {
		if info.Frames == 0 {
			return bad("animation without frames")
		}
		return nil
	}
	info.Frames = 1
	return imageData(image, info.Width, info.Height)
}

// frame validates one ANMF payload: offsets, size, duration and its image data.
func frame(p []byte, info *WebPInfo) error {
	if len(p) < 16 {
		return bad("ANMF chunk too short")
	}
	info.Frames++
	if info.Frames > MaxFrames {
		return bad("more than %d frames", MaxFrames)
	}
	fx, fy := u24(p[0:3])*2, u24(p[3:6])*2
	fw, fh := u24(p[6:9])+1, u24(p[9:12])+1
	info.DurationMs += u24(p[12:15])
	if info.DurationMs > MaxDurationMs {
		return bad("animation longer than %d ms", MaxDurationMs)
	}
	if fx+fw > info.Width || fy+fh > info.Height {
		return bad("frame outside the canvas")
	}
	sub, err := chunks(p[16:])
	if err != nil {
		return err
	}
	// Unknown chunks inside a frame are not allowed either.
	return imageData(sub, fw, fh)
}
