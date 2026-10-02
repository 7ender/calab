package builtinstickers_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/calaba/calaba/server/internal/builtinstickers"
	"github.com/calaba/calaba/server/internal/stickers"
)

func TestAssets(t *testing.T) {
	p := builtinstickers.Pack()
	if !p.Builtin || p.WorkspaceId != "" || len(p.Stickers) != 16 {
		t.Fatalf("invalid built-in pack: %v", p)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/stickers/builtin/{name}", builtinstickers.ServeHTTP)
	seen := map[string]bool{}
	for _, s := range p.Stickers {
		if seen[s.Id] {
			t.Fatal("duplicate ID")
		}
		seen[s.Id] = true
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequestWithContext(t.Context(), "GET", s.Url, nil))
		if w.Code != 200 || w.Header().Get("Content-Type") != "image/webp" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("bad response: %v", w)
		}
		info, err := stickers.ValidateWebP(w.Body.Bytes())
		if err != nil || info.Width != 512 || info.Height != 512 || info.Animated || w.Body.Len() != int(s.Size) {
			t.Fatalf("asset %s: %v %v", s.Id, info, err)
		}
		cached := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(t.Context(), "GET", s.Url, nil)
		req.Header.Set("If-None-Match", w.Header().Get("ETag"))
		mux.ServeHTTP(cached, req)
		if cached.Code != 304 {
			t.Fatalf("cache: %d", cached.Code)
		}
	}
	for _, path := range []string{"unknown.webp", "manifest.json", "joy.webp"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequestWithContext(t.Context(), "GET", "/api/stickers/builtin/"+path, nil))
		if w.Code != 404 {
			t.Fatalf("unknown resource %s: %d", path, w.Code)
		}
	}
	p.Stickers[0].Emoji = "changed"
	if builtinstickers.Pack().Stickers[0].Emoji == "changed" {
		t.Fatal("shared mutable catalog")
	}
}
