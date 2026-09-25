package unfurl

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"time"

	"github.com/redis/rueidis"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Limits and cache TTLs.
const (
	pageTimeout   = 5 * time.Second
	imageTimeout  = 10 * time.Second
	maxPage       = 1 << 20
	maxImage      = 5 << 20
	cacheTTL      = 24 * time.Hour
	negativeTTL   = time.Hour
	imageCacheAge = 24 * 3600
)

// Service serves /api/unfurl and /api/unfurl/image.
type Service struct {
	redis     rueidis.Client
	page, img *http.Client
	key       []byte // HMAC key for image proxy URLs
	limiter   *redisx.RateLimiter
}

// Options tune the service. AllowAddr overrides the address policy (tests only; nil = PublicAddr).
type Options struct {
	AllowAddr func(netip.Addr) bool
}

// NewService creates the unfurl service. secret is used to derive the image-URL key.
func NewService(r rueidis.Client, secret []byte, limiter *redisx.RateLimiter, o Options) *Service {
	allow := o.AllowAddr
	if allow == nil {
		allow = PublicAddr
	}
	m := hmac.New(sha256.New, secret)
	m.Write([]byte("calaba unfurl image proxy"))
	return &Service{redis: r, page: newClient(pageTimeout, allow), img: newClient(imageTimeout, allow), key: m.Sum(nil), limiter: limiter}
}

// Routes registers authenticated routes.
func (s *Service) Routes(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/unfurl", wrap(httpx.HandlerFunc(s.unfurl)))
	mux.Handle("GET /api/unfurl/image", wrap(httpx.HandlerFunc(s.image)))
}

func (s *Service) sign(u string) string {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte(u))
	return hex.EncodeToString(m.Sum(nil))
}

// proxied returns the API path through which a client loads an origin image.
func (s *Service) proxied(u string) string {
	if u == "" {
		return ""
	}
	return "/api/unfurl/image?" + url.Values{"url": {u}, "sig": {s.sign(u)}}.Encode()
}

func cacheKey(u string) string {
	h := sha256.Sum256([]byte(u))
	return "unfurl:" + hex.EncodeToString(h[:])
}

func (s *Service) limit(r *http.Request, kind string) error {
	ok, err := s.limiter.Allow(r.Context(), kind+":"+auth.MustFromContext(r.Context()).UserID.String())
	if err == nil && !ok {
		return httpx.RateLimited()
	}
	return nil
}

var errNoPreview = httpx.NotFound("preview")

func (s *Service) unfurl(w http.ResponseWriter, r *http.Request) error {
	u, err := CheckURL(r.URL.Query().Get("url"))
	if err != nil {
		return httpx.Validation("url", "must be an http(s) URL")
	}
	key := cacheKey(u.String())
	if b, err := s.redis.Do(r.Context(), s.redis.B().Get().Key(key).Build()).AsBytes(); err == nil {
		if string(b) == "!" {
			return errNoPreview
		}
		var resp v1.UnfurlResponse
		if proto.Unmarshal(b, &resp) == nil {
			w.Header().Set("Cache-Control", "private, max-age=3600")
			httpx.Write(w, http.StatusOK, &resp)
			return nil
		}
	}
	if err := s.limit(r, "unfurl"); err != nil {
		return err
	}
	card, err := s.fetch(r.Context(), u)
	if err != nil {
		slog.DebugContext(r.Context(), "unfurl failed", "url", u.String(), "err", err)
		_ = s.redis.Do(r.Context(), s.redis.B().Set().Key(key).Value("!").Ex(negativeTTL).Build()).Error()
		return errNoPreview
	}
	resp := &v1.UnfurlResponse{
		Url: card.URL, Title: card.Title, Description: card.Description, SiteName: card.SiteName,
		ImageUrl: s.proxied(card.Image), FaviconUrl: s.proxied(card.Favicon),
	}
	if b, err := proto.Marshal(resp); err == nil {
		_ = s.redis.Do(r.Context(), s.redis.B().Set().Key(key).Value(rueidis.BinaryString(b)).Ex(cacheTTL).Build()).Error()
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

var errNotHTML = errors.New("unfurl: not an HTML page")

// fetch downloads (≤ 1 MB of) an HTML page and parses its preview metadata.
func (s *Service) fetch(ctx context.Context, u *url.URL) (Card, error) {
	ctx, cancel := context.WithTimeout(ctx, pageTimeout)
	defer cancel()
	resp, err := get(ctx, s.page, u.String(), "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1")
	if err != nil {
		return Card{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return Card{}, errors.New("unfurl: status " + strconv.Itoa(resp.StatusCode))
	}
	ct := resp.Header.Get("Content-Type")
	if !isHTML(ct) {
		return Card{}, errNotHTML
	}
	card := Parse(io.LimitReader(resp.Body, maxPage), ct, resp.Request.URL)
	if card.Title == "" && card.Description == "" && card.Image == "" {
		return Card{}, errors.New("unfurl: no metadata")
	}
	return card, nil
}

var imageTypes = map[string]bool{
	"image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true, "image/x-icon": true,
	"image/vnd.microsoft.icon": true, "image/avif": true,
}

// image proxies a signed origin image (≤ 5 MB, raster types only; never SVG).
func (s *Service) image(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	raw, sig := q.Get("url"), q.Get("sig")
	if !hmac.Equal([]byte(sig), []byte(s.sign(raw))) {
		return httpx.Forbidden("bad signature")
	}
	u, err := CheckURL(raw)
	if err != nil {
		return httpx.NotFound("image")
	}
	if err := s.limit(r, "unfurl-img"); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), imageTimeout)
	defer cancel()
	resp, err := get(ctx, s.img, u.String(), "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8")
	if err != nil {
		return httpx.NotFound("image")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK || resp.ContentLength > maxImage {
		return httpx.NotFound("image")
	}
	head := make([]byte, 512)
	n, _ := io.ReadFull(resp.Body, head)
	head = head[:n]
	ct := http.DetectContentType(head)
	if !imageTypes[ct] {
		if declared := resp.Header.Get("Content-Type"); declared == "image/avif" && n > 12 && string(head[4:12]) == "ftypavif" {
			ct = declared
		} else {
			return httpx.NotFound("image")
		}
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("Cache-Control", "private, max-age="+strconv.Itoa(imageCacheAge))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	if resp.ContentLength > 0 {
		h.Set("Content-Length", strconv.FormatInt(resp.ContentLength, 10))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(head)
	if _, err := io.Copy(w, io.LimitReader(resp.Body, maxImage-int64(n))); err != nil {
		panic(http.ErrAbortHandler)
	}
	var extra [1]byte
	if k, _ := resp.Body.Read(extra[:]); k > 0 {
		panic(http.ErrAbortHandler) // larger than 5 MB: cut the response off
	}
	return nil
}
