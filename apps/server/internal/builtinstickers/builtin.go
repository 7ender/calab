// Package builtinstickers contains the immutable public Calab Stikers artwork (ADR-0054).
package builtinstickers

import (
	"bytes"
	"embed"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

//go:embed manifest.json assets/*.webp
var resources embed.FS

type entry struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Emoji string `json:"emoji"`
}

var catalog struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Stickers []entry `json:"stickers"`
}
var images = map[string][]byte{}

func init() {
	data, err := resources.ReadFile("manifest.json")
	if err != nil {
		panic(err)
	}
	if err = json.Unmarshal(data, &catalog); err != nil {
		panic(err)
	}
	for _, e := range catalog.Stickers {
		b, err := resources.ReadFile("assets/" + e.Name + ".webp")
		if err != nil {
			panic(err)
		}
		images[e.ID] = b
	}
}

// PackID is stable across installations and releases.
func PackID() string { return catalog.ID }

// Sticker returns fresh metadata only for an allowlisted immutable ID.
func Sticker(id string) *v1.Sticker {
	for _, e := range catalog.Stickers {
		if e.ID == id {
			return &v1.Sticker{Id: e.ID, PackId: catalog.ID, Emoji: e.Emoji,
				Url: "/api/stickers/builtin/" + e.ID + ".webp", Width: 512, Height: 512,
				Size: uint32(len(images[id]))} //nolint:gosec // validated assets are <= 512 KiB
		}
	}
	return nil
}

// Pack returns fresh protobuf values so handlers cannot mutate the catalog.
func Pack() *v1.StickerPack {
	p := &v1.StickerPack{Id: catalog.ID, Name: catalog.Name, ShortName: "calab_stikers", Builtin: true}
	for _, e := range catalog.Stickers {
		p.Stickers = append(p.Stickers, Sticker(e.ID))
	}
	p.CoverStickerId = p.Stickers[0].Id
	return p
}

// ServeHTTP serves only public built-in artwork, never workspace uploads.
func ServeHTTP(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !strings.HasSuffix(name, ".webp") {
		http.NotFound(w, r)
		return
	}
	id := strings.TrimSuffix(name, ".webp")
	data, ok := images[id]
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", `"`+id+`"`)
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
}
