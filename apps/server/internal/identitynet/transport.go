package identitynet

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/calaba/calaba/server/internal/unfurl"
)

var (
	// ErrPolicy identifies a rejected endpoint or network address without its URL.
	ErrPolicy = errors.New("identitynet: endpoint policy rejected")
	// ErrNetwork redacts upstream DNS, dial, TLS, and body-read diagnostics.
	ErrNetwork = errors.New("identitynet: HTTPS request failed")
	// ErrTooLarge identifies a request or response exceeding its byte budget.
	ErrTooLarge = errors.New("identitynet: body limit exceeded")
	// ErrRedirect identifies a rejected redirect response.
	ErrRedirect = errors.New("identitynet: redirect rejected")
)

// Endpoint is operator-approved policy for one exact HTTPS URL. Empty
// ApprovedCIDRs permits any public address. Private and test exceptions require
// their own explicit prefixes and remain subject to ApprovedCIDRs when present.
type Endpoint struct {
	URL               string
	ApprovedCIDRs     []netip.Prefix
	PrivateCIDRs      []netip.Prefix
	TestLoopbackCIDRs []netip.Prefix
	RootCAs           *x509.CertPool
	MaxResponseBytes  int64 // default 256 KiB; hard ceiling 1 MiB
}

// Resolver is consulted at connect time; every returned address must be allowed.
type Resolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

// Dialer must connect to the literal address supplied, obey context cancellation,
// and report the actual TCP peer in RemoteAddr. It is a trusted operator/test hook.
type Dialer interface {
	DialContext(context.Context, string, string) (net.Conn, error)
}

// Clock can inject deterministic request/connect cancellation in tests. Its
// child context is always nested inside the real hard deadline, so a clock hook
// cannot expand the network budget. Implementations must be concurrency-safe.
type Clock interface {
	WithTimeout(context.Context, time.Duration) (context.Context, context.CancelFunc)
}

// Config is immutable after construction. Zero durations select secure defaults;
// nonzero durations may only shorten the hard limits. Hooks are trusted code,
// never settings that a workspace administrator can provide.
type Config struct {
	Endpoints       []Endpoint
	Resolver        Resolver
	Dialer          Dialer
	Clock           Clock
	RequestTimeout  time.Duration // default/hard ceiling 10 seconds
	ConnectTimeout  time.Duration // default/hard ceiling 3 seconds
	HeaderTimeout   time.Duration // default/hard ceiling 5 seconds
	MaxRequestBytes int64         // default/hard ceiling 64 KiB
}

type target struct {
	u    *url.URL
	e    Endpoint
	http *http.Transport
}

// Transport implements http.RoundTripper without proxy or redirect support.
type Transport struct {
	targets    map[string]*target
	timeout    time.Duration
	maxRequest int64
	clock      Clock
}

// Client is a Doer that removes net/http's URL-bearing error wrapper.
type Client struct {
	http      *http.Client
	transport *Transport
}

// NewClient creates a reusable client with secret-safe Do errors.
func NewClient(c Config) (*Client, error) {
	t, err := NewTransport(c)
	if err != nil {
		return nil, err
	}
	return &Client{transport: t, http: &http.Client{Transport: t, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

// Do executes a request. Errors contain neither query, headers, body, nor raw
// resolver/dialer/TLS diagnostics; context errors remain recognizable with Is.
func (c *Client) Do(req *http.Request) (*http.Response, error) {
	if req == nil {
		return nil, ErrPolicy
	}
	r, err := c.http.Do(req) //nolint:gosec // G704: exact URL policy and connect-time address pinning in Transport
	if err != nil {
		return nil, safeError(err)
	}
	return r, nil
}

// CloseIdleConnections releases connection pools when a policy is replaced.
func (c *Client) CloseIdleConnections() { c.transport.CloseIdleConnections() }

// NewTransport constructs separate TLS/connection pools for every endpoint.
func NewTransport(c Config) (*Transport, error) {
	request, ok1 := duration(c.RequestTimeout, 10*time.Second)
	connect, ok2 := duration(c.ConnectTimeout, 3*time.Second)
	header, ok3 := duration(c.HeaderTimeout, 5*time.Second)
	if !ok1 || !ok2 || !ok3 || len(c.Endpoints) == 0 || len(c.Endpoints) > 32 || c.MaxRequestBytes < 0 || c.MaxRequestBytes > 64<<10 {
		return nil, ErrPolicy
	}
	if c.MaxRequestBytes == 0 {
		c.MaxRequestBytes = 64 << 10
	}
	if c.Resolver == nil {
		c.Resolver = net.DefaultResolver
	}
	if c.Dialer == nil {
		c.Dialer = &net.Dialer{Timeout: connect}
	}
	t := &Transport{targets: make(map[string]*target), timeout: request, maxRequest: c.MaxRequestBytes, clock: c.Clock}
	for _, e := range c.Endpoints {
		u, err := endpointURL(e.URL)
		if err != nil {
			return nil, ErrPolicy
		}
		if _, exists := t.targets[e.URL]; exists {
			return nil, ErrPolicy
		}
		if !validPrefixes(e) || e.MaxResponseBytes < 0 || e.MaxResponseBytes > 1<<20 {
			return nil, ErrPolicy
		}
		if len(e.TestLoopbackCIDRs) > 0 {
			a, err := netip.ParseAddr(u.Hostname())
			if err != nil || !a.Unmap().IsLoopback() {
				return nil, ErrPolicy
			}
		}
		if e.MaxResponseBytes == 0 {
			e.MaxResponseBytes = 256 << 10
		}
		e.ApprovedCIDRs = append([]netip.Prefix(nil), e.ApprovedCIDRs...)
		e.PrivateCIDRs = append([]netip.Prefix(nil), e.PrivateCIDRs...)
		e.TestLoopbackCIDRs = append([]netip.Prefix(nil), e.TestLoopbackCIDRs...)
		if e.RootCAs != nil {
			e.RootCAs = e.RootCAs.Clone()
		}
		p := &target{u: u, e: e}
		p.http = &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				ctx, cancel := budget(ctx, connect, c.Clock)
				defer cancel()
				return dial(ctx, c.Resolver, c.Dialer, p, network, address)
			},
			TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: e.RootCAs},
			TLSHandshakeTimeout: connect, ResponseHeaderTimeout: header,
			MaxResponseHeaderBytes: 32 << 10, MaxIdleConns: 2, MaxConnsPerHost: 4,
			IdleConnTimeout: 30 * time.Second,
			// Re-resolve and check the actual peer on every request, including
			// JWKS refreshes after an operator or DNS change.
			DisableKeepAlives: true,
			// HTTP/1 avoids cross-origin HTTP/2 connection coalescing.
			ForceAttemptHTTP2: false,
		}
		t.targets[e.URL] = p
	}
	return t, nil
}

func duration(value, ceiling time.Duration) (time.Duration, bool) {
	if value == 0 {
		return ceiling, true
	}
	return value, value > 0 && value <= ceiling
}

func endpointURL(raw string) (*url.URL, error) {
	if len(raw) == 0 || len(raw) > 4096 {
		return nil, ErrPolicy
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" || u.RawFragment != "" || strings.Contains(raw, "#") || u.Opaque != "" {
		return nil, ErrPolicy
	}
	h := u.Hostname()
	if h == "" || strings.Contains(h, "%") || strings.HasSuffix(h, ".") || h != strings.ToLower(h) {
		return nil, ErrPolicy
	}
	if a, err := netip.ParseAddr(h); err == nil {
		if a.Zone() != "" || a.String() != h {
			return nil, ErrPolicy
		}
	} else {
		// ASCII DNS names only; reject ambiguous numeric IP spellings.
		if len(h) > 253 || strings.Trim(h, "0123456789.") == "" {
			return nil, ErrPolicy
		}
		for _, label := range strings.Split(h, ".") {
			if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return nil, ErrPolicy
			}
			for _, ch := range label {
				if (ch < 'a' || ch > 'z') && (ch < '0' || ch > '9') && ch != '-' {
					return nil, ErrPolicy
				}
			}
		}
	}
	port := u.Port()
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != port {
			return nil, ErrPolicy
		}
	}
	if strings.HasSuffix(u.Host, ":") {
		return nil, ErrPolicy
	}
	if u.String() != raw {
		return nil, ErrPolicy
	}
	return u, nil
}

func validPrefixes(e Endpoint) bool {
	for _, list := range [][]netip.Prefix{e.ApprovedCIDRs, e.PrivateCIDRs, e.TestLoopbackCIDRs} {
		for _, p := range list {
			if !p.IsValid() || p.Addr().Is4In6() || p != p.Masked() {
				return false
			}
		}
	}
	for _, p := range e.PrivateCIDRs {
		if !p.Addr().IsPrivate() || (p.Addr().Is4() && p.Bits() < 8) || (p.Addr().Is6() && p.Bits() < 7) {
			return false
		}
		last := prefixLast(p)
		if !last.IsPrivate() {
			return false
		}
	}
	for _, p := range e.TestLoopbackCIDRs {
		if p.Bits() != p.Addr().BitLen() || !p.Addr().IsLoopback() {
			return false
		}
	}
	return true
}

func prefixLast(p netip.Prefix) netip.Addr {
	b := p.Addr().As16()
	start := p.Bits()
	if p.Addr().Is4() {
		start += 96
	}
	for bit := start; bit < 128; bit++ {
		b[bit/8] |= 1 << (7 - bit%8)
	}
	a := netip.AddrFrom16(b)
	if p.Addr().Is4() {
		a = a.Unmap()
	}
	return a
}

func contains(list []netip.Prefix, a netip.Addr) bool {
	for _, p := range list {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

func (p *target) allows(a netip.Addr) bool {
	if !a.IsValid() || a.Zone() != "" {
		return false
	}
	a = a.Unmap()
	// These metadata/control-plane destinations remain forbidden even under
	// an operator's broader private allowlist.
	if a == netip.MustParseAddr("168.63.129.16") || a == netip.MustParseAddr("fd00:ec2::254") || a == netip.MustParseAddr("fd20:ce::254") {
		return false
	}
	if len(p.e.ApprovedCIDRs) > 0 && !contains(p.e.ApprovedCIDRs, a) {
		return false
	}
	if a.IsLoopback() {
		return contains(p.e.TestLoopbackCIDRs, a)
	}
	if a.IsPrivate() {
		return contains(p.e.PrivateCIDRs, a)
	}
	if !a.IsGlobalUnicast() || (a.Is6() && !netip.MustParsePrefix("2000::/3").Contains(a)) {
		return false
	}
	for _, reserved := range []string{"2001::/23", "3fff::/20", "5f00::/16"} {
		if netip.MustParsePrefix(reserved).Contains(a) {
			return false
		}
	}
	return unfurl.PublicAddr(a)
}

func dial(ctx context.Context, resolver Resolver, d Dialer, p *target, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	expectedPort := p.u.Port()
	if expectedPort == "" {
		expectedPort = "443"
	}
	if err != nil || host != p.u.Hostname() || port != expectedPort || network != "tcp" {
		return nil, ErrPolicy
	}
	var addrs []netip.Addr
	if a, err := netip.ParseAddr(host); err == nil {
		addrs = []netip.Addr{a}
	} else {
		addrs, err = resolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil, safeError(err)
		}
	}
	if len(addrs) == 0 || len(addrs) > 32 {
		return nil, ErrPolicy
	}
	for _, a := range addrs {
		if !p.allows(a) {
			return nil, ErrPolicy
		}
	}
	for _, a := range addrs {
		conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(a.Unmap().String(), port))
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			continue
		}
		peer, ok := conn.RemoteAddr().(*net.TCPAddr)
		if !ok || peer.Port != mustPort(port) || !p.allows(peer.AddrPort().Addr()) || peer.AddrPort().Addr().Unmap() != a.Unmap() {
			_ = conn.Close()
			return nil, ErrPolicy
		}
		return conn, nil
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return nil, ErrNetwork
}

func mustPort(s string) int { n, _ := strconv.Atoi(s); return n }

// RoundTrip rejects unapproved URLs and Host overrides before sending secrets.
func (t *Transport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req == nil || req.URL == nil {
		return nil, ErrPolicy
	}
	p, ok := t.targets[req.URL.String()]
	if !ok || req.URL.User != nil || (req.Host != "" && req.Host != p.u.Host) || (req.Method != http.MethodGet && req.Method != http.MethodPost) {
		closeRequest(req)
		return nil, ErrPolicy
	}
	if req.ContentLength > t.maxRequest {
		closeRequest(req)
		return nil, ErrTooLarge
	}
	ctx, cancel := budget(req.Context(), t.timeout, t.clock)
	copyReq := req.Clone(ctx)
	copyReq.GetBody = nil // never replay a credential-bearing request
	if req.Body != nil {
		copyReq.Body = &limitedBody{body: req.Body, remaining: t.maxRequest, ctx: ctx}
	}
	resp, err := p.http.RoundTrip(copyReq)
	if err != nil {
		cancel()
		return nil, safeError(err)
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		_ = resp.Body.Close()
		cancel()
		return nil, ErrRedirect
	}
	if resp.ContentLength > p.e.MaxResponseBytes {
		_ = resp.Body.Close()
		cancel()
		return nil, ErrTooLarge
	}
	resp.Body = &limitedBody{body: resp.Body, remaining: p.e.MaxResponseBytes, cancel: cancel, ctx: ctx}
	return resp, nil
}

func budget(parent context.Context, limit time.Duration, clock Clock) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(parent, limit)
	if clock == nil {
		return ctx, cancel
	}
	child, stop := clock.WithTimeout(ctx, limit)
	return child, func() { stop(); cancel() }
}

func closeRequest(req *http.Request) {
	if req.Body != nil {
		_ = req.Body.Close()
	}
}

// CloseIdleConnections releases all endpoint pools.
func (t *Transport) CloseIdleConnections() {
	for _, p := range t.targets {
		p.http.CloseIdleConnections()
	}
}

type limitedBody struct {
	body      io.ReadCloser
	remaining int64
	ctx       context.Context
	cancel    context.CancelFunc
	once      sync.Once
}

func (b *limitedBody) Read(dst []byte) (int, error) {
	if len(dst) == 0 {
		return 0, nil
	}
	if err := b.ctx.Err(); err != nil {
		return 0, err
	}
	if b.remaining == 0 {
		var probe [1]byte
		n, err := b.body.Read(probe[:])
		if n > 0 {
			return 0, ErrTooLarge
		}
		return 0, safeBodyError(err)
	}
	if int64(len(dst)) > b.remaining {
		dst = dst[:b.remaining]
	}
	n, err := b.body.Read(dst)
	b.remaining -= int64(n)
	if b.ctx.Err() != nil {
		return n, b.ctx.Err()
	}
	return n, safeBodyError(err)
}

func (b *limitedBody) Close() error {
	b.once.Do(func() {
		if b.cancel != nil {
			b.cancel()
		}
		_ = b.body.Close()
	})
	return nil
}

func safeBodyError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, io.EOF) {
		return io.EOF
	}
	return safeError(err)
}
func safeError(err error) error {
	for _, safe := range []error{context.Canceled, context.DeadlineExceeded, ErrPolicy, ErrTooLarge, ErrRedirect} {
		if errors.Is(err, safe) {
			return safe
		}
	}
	return ErrNetwork
}
