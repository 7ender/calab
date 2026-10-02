// Package webhook is the outgoing webhook engine shared by bot webhooks (ADR-0031 §4) and board
// webhooks (ADR-0058 §4): the SSRF-safe Transport (https only, public addresses only, no
// redirects, 10 s), the retry schedule, the v1 signature, and a Worker that delivers the rows of
// an outbox Queue, one per cluster under a Valkey lock.
package webhook

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/unfurl"
)

// Options tune delivery; zero values are the production defaults.
type Options struct {
	// AllowAddr: which resolved addresses may be dialed (nil = unfurl.PublicAddr; tests
	// allow loopback). Webhook URLs are https only.
	AllowAddr func(netip.Addr) bool
	// RootCAs trusts extra certificate authorities (tests: httptest TLS servers); nil = system.
	RootCAs *x509.CertPool
	// Poll: how often the worker looks for due deliveries (default 2 s).
	Poll time.Duration
	// Backoff: wait before retry attempt+1 (default 1 min doubling, at most 1 h).
	Backoff func(attempt int32) time.Duration
	// GiveUp: a delivery is dropped, and a webhook failing that long is disabled (default 24 h).
	GiveUp time.Duration
}

// WithDefaults fills the zero values with the production defaults.
func (o Options) WithDefaults() Options {
	if o.AllowAddr == nil {
		o.AllowAddr = unfurl.PublicAddr
	}
	if o.Poll <= 0 {
		o.Poll = 2 * time.Second
	}
	if o.Backoff == nil {
		o.Backoff = Backoff
	}
	if o.GiveUp <= 0 {
		o.GiveUp = 24 * time.Hour
	}
	return o
}

// Backoff is the default retry schedule: 1 min doubling, capped at 1 h.
func Backoff(attempt int32) time.Duration {
	if attempt >= 6 {
		return time.Hour
	}
	return min(time.Minute<<attempt, time.Hour)
}

const (
	// Timeout bounds one delivery (connect, TLS, response headers, whole request).
	Timeout = 10 * time.Second
	// MaxURL is the longest webhook URL accepted.
	MaxURL = 2048
	// maxResponse: how much of a receiver's answer is read (and discarded).
	maxResponse = 64 << 10
)

// Transport POSTs webhook bodies with the SSRF policy: https only, every dialed address
// allowed by Options.AllowAddr (checked after DNS resolution), no environment proxies, no
// redirects, Timeout.
type Transport struct {
	client *http.Client
	allow  func(netip.Addr) bool
}

// NewTransport builds the transport of o (defaults applied).
func NewTransport(o Options) *Transport {
	o = o.WithDefaults()
	tr := unfurl.SafeTransport(Timeout, o.AllowAddr)
	if o.RootCAs != nil {
		tr.TLSClientConfig = &tls.Config{RootCAs: o.RootCAs, MinVersion: tls.VersionTLS12}
	}
	return &Transport{
		allow: o.AllowAddr,
		client: &http.Client{
			Transport: tr, Timeout: Timeout,
			// A redirect is an answer, not a success: never follow it (SSRF).
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

// CheckURL validates a webhook URL: absolute https without credentials, ≤ MaxURL; a literal IP
// address (or localhost) must be allowed by the policy — host names are checked when dialing.
// Errors are 422 VALIDATION on field "url". Returns the normalized URL.
func (t *Transport) CheckURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if len(raw) > MaxURL {
		return "", httpx.Validation("url", "URL is too long")
	}
	u, err := unfurl.CheckURL(raw)
	if err != nil || u.Scheme != "https" {
		return "", httpx.Validation("url", "webhook URL must be an absolute https URL without credentials")
	}
	host := u.Hostname()
	if a, err := netip.ParseAddr(host); err == nil && !t.allow(a) {
		return "", httpx.Validation("url", "webhook URL must point to a public address")
	}
	if h := strings.ToLower(host); h == "localhost" || strings.HasSuffix(h, ".localhost") {
		if !t.allow(netip.MustParseAddr("127.0.0.1")) {
			return "", httpx.Validation("url", "webhook URL must point to a public address")
		}
	}
	return u.String(), nil
}

// ErrNotAllowed is returned by Post when the URL no longer passes CheckURL.
var ErrNotAllowed = errors.New("webhook URL not allowed")

// Post sends body as application/json with the given headers. It returns the receiver's
// status (0 = no answer) and an error unless the status is 2xx ("HTTP 500", "HTTP 302", …).
func (t *Transport) Post(ctx context.Context, rawURL string, body []byte, h http.Header) (int, error) {
	if _, err := t.CheckURL(rawURL); err != nil {
		return 0, ErrNotAllowed
	}
	rctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodPost, rawURL, bytes.NewReader(body)) //nolint:gosec // G704: https only, SSRF-safe dialer
	if err != nil {
		return 0, err
	}
	for k, vs := range h {
		req.Header[k] = vs
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := t.client.Do(req) //nolint:gosec // G704: see above
	if err != nil {
		return 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxResponse))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return resp.StatusCode, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return resp.StatusCode, nil
}

// ---- signature v1 (ADR-0058 §4) ----

// Header names of the v1 signature.
const (
	HeaderTimestamp = "X-Calab-Timestamp"
	HeaderSignature = "X-Calab-Signature"
	// Tolerance: receivers reject a timestamp further than this from their clock (replay).
	Tolerance = 5 * time.Minute
)

// Sign returns the v1 X-Calab-Signature value: "v1=" + hex HMAC-SHA256(secret, ts + "." + body),
// ts being the X-Calab-Timestamp value (unix seconds).
func Sign(secret []byte, ts int64, body []byte) string {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(strconv.FormatInt(ts, 10)))
	m.Write([]byte("."))
	m.Write(body)
	return "v1=" + hex.EncodeToString(m.Sum(nil))
}

// Verify is the reference receiver check of a v1 signature (docs/19): the timestamp is within
// Tolerance of now and the signature matches (constant-time).
func Verify(secret []byte, h http.Header, body []byte, now time.Time) error {
	ts, err := strconv.ParseInt(h.Get(HeaderTimestamp), 10, 64)
	if err != nil {
		return errors.New("missing or invalid " + HeaderTimestamp)
	}
	if d := now.Sub(time.Unix(ts, 0)); d > Tolerance || d < -Tolerance {
		return errors.New("timestamp outside the tolerance")
	}
	want := Sign(secret, ts, body)
	if !hmac.Equal([]byte(h.Get(HeaderSignature)), []byte(want)) {
		return errors.New("signature mismatch")
	}
	return nil
}
