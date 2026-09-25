package files

import (
	"bytes"
	"context"
	"errors"
	"image"
	_ "image/gif" // register decoders
	_ "image/jpeg"
	_ "image/png"
	"io"

	"github.com/gen2brain/webp"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // register decoder
)

// Thumbnail limits: the longer side is scaled to ThumbMaxSide; images above MaxPixels are
// not decoded at all (decompression bombs, memory budget: a 24 MP RGBA image is ~96 MiB).
const (
	ThumbMaxSide = 512
	MaxPixels    = 24_000_000
	thumbQuality = 80
)

// ErrTooManyPixels means the image is too large to thumbnail.
var ErrTooManyPixels = errors.New("files: image too large to thumbnail")

// One decode at a time bounds peak memory; thumbnails are small and fast otherwise.
var thumbSlot = make(chan struct{}, 1)

// ImageConfig reads only the header (cheap) and returns dimensions.
func ImageConfig(r io.Reader) (image.Config, error) {
	cfg, _, err := image.DecodeConfig(r)
	return cfg, err
}

// Thumbnail decodes an image (first frame for GIF), scales it so that the longer side is at
// most ThumbMaxSide (never upscales) and encodes it as lossy WebP.
func Thumbnail(ctx context.Context, open func() (io.ReadCloser, error)) ([]byte, error) {
	rc, err := open()
	if err != nil {
		return nil, err
	}
	cfg, _, err := image.DecodeConfig(rc)
	_ = rc.Close()
	if err != nil {
		return nil, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > MaxPixels {
		return nil, ErrTooManyPixels
	}
	select {
	case thumbSlot <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-thumbSlot }()

	rc, err = open()
	if err != nil {
		return nil, err
	}
	src, _, err := image.Decode(rc)
	_ = rc.Close()
	if err != nil {
		return nil, err
	}
	w, h := ThumbSize(cfg.Width, cfg.Height)
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	var buf bytes.Buffer
	if err := webp.Encode(&buf, dst, webp.Options{Quality: thumbQuality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ThumbSize fits w×h into ThumbMaxSide×ThumbMaxSide keeping the aspect ratio.
func ThumbSize(w, h int) (int, int) {
	if w <= ThumbMaxSide && h <= ThumbMaxSide {
		return w, h
	}
	if w >= h {
		return ThumbMaxSide, max(1, h*ThumbMaxSide/w)
	}
	return max(1, w*ThumbMaxSide/h), ThumbMaxSide
}
