package identitynet

import (
	"compress/gzip"
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type resolverFunc func(context.Context, string, string) ([]netip.Addr, error)

func (f resolverFunc) LookupNetIP(c context.Context, n, h string) ([]netip.Addr, error) {
	return f(c, n, h)
}

type dialerFunc func(context.Context, string, string) (net.Conn, error)

func (f dialerFunc) DialContext(c context.Context, n, a string) (net.Conn, error) { return f(c, n, a) }

type clockFunc func(context.Context, time.Duration) (context.Context, context.CancelFunc)

func (f clockFunc) WithTimeout(c context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return f(c, d)
}

type peerConn struct {
	net.Conn
	peer *net.TCPAddr
}

func (c *peerConn) RemoteAddr() net.Addr { return c.peer }

func fixture(t *testing.T, handler http.HandlerFunc) (*httptest.Server, Endpoint) {
	t.Helper()
	s := httptest.NewUnstartedServer(handler)
	s.Config.ErrorLog = log.New(io.Discard, "", 0)
	s.StartTLS()
	t.Cleanup(s.Close)
	pool := x509.NewCertPool()
	pool.AddCert(s.Certificate())
	return s, Endpoint{URL: s.URL + "/endpoint", RootCAs: pool, TestLoopbackCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}}
}
func client(t *testing.T, c Config) *Client {
	t.Helper()
	v, err := NewClient(c)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(v.CloseIdleConnections)
	return v
}
func request(ctx context.Context, t *testing.T, method, target string, body io.Reader) *http.Request {
	t.Helper()
	r, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func readClose(t *testing.T, r *http.Response) ([]byte, error) {
	t.Helper()
	defer func() { _ = r.Body.Close() }()
	return io.ReadAll(r.Body)
}

//nolint:bodyclose // Successful bodies are closed by readClose; rejection cases require no response.
func TestHTTPSExactPolicyAndOperatorTestException(t *testing.T) {
	var hits atomic.Int32
	s, e := fixture(t, func(w http.ResponseWriter, _ *http.Request) { hits.Add(1); _, _ = io.WriteString(w, "ok") })
	c := client(t, Config{Endpoints: []Endpoint{e}})
	r, err := c.Do(request(t.Context(), t, http.MethodGet, e.URL, nil))
	if err != nil {
		t.Fatal(err)
	}
	data, err := readClose(t, r)
	if err != nil || string(data) != "ok" {
		t.Fatalf("body %q %v", data, err)
	}
	for _, target := range []string{s.URL + "/other", e.URL + "?client_secret=TOP-SECRET", strings.Replace(e.URL, "127.0.0.1", "localhost", 1), strings.Replace(e.URL, "https:", "http:", 1), e.URL + "#fragment", strings.Replace(e.URL, "https://", "https://user:TOP-SECRET@", 1)} {
		r, err := c.Do(request(t.Context(), t, http.MethodPost, target, strings.NewReader("client_secret=TOP-SECRET")))
		if r != nil || !errors.Is(err, ErrPolicy) {
			t.Fatalf("unapproved endpoint: %v", err)
		}
		if strings.Contains(err.Error(), "SECRET") {
			t.Fatal("URL secret leaked")
		}
	}
	if hits.Load() != 1 {
		t.Fatal("policy rejection reached the network")
	}
	// An endpoint URL supplied by itself cannot authorize a loopback destination.
	e.TestLoopbackCIDRs = nil
	cloud := client(t, Config{Endpoints: []Endpoint{e}})
	if _, err := cloud.Do(request(t.Context(), t, http.MethodGet, e.URL, nil)); !errors.Is(err, ErrPolicy) {
		t.Fatalf("URL permitted loopback: %v", err)
	}
	// Scoped exceptions preserve CA verification.
	e.TestLoopbackCIDRs = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	e.RootCAs = x509.NewCertPool()
	untrusted := client(t, Config{Endpoints: []Endpoint{e}})
	if _, err := untrusted.Do(request(t.Context(), t, http.MethodGet, e.URL, nil)); !errors.Is(err, ErrNetwork) {
		t.Fatalf("TLS bypass: %v", err)
	}
}

//nolint:bodyclose // Successful bodies are closed by readClose; rejection cases require no response.
func TestConstructorRejectsAmbiguousOrBroadPolicies(t *testing.T) {
	for _, raw := range []string{"http://example.test/token", "https://user:secret@example.test/token", "https://example.test/token#", "https://example.test/token#secret", "https://EXAMPLE.test/token", "https://example.test./token", "https://127.1/token", "https://0177.0.0.1/token", "https://2130706433/token", "https://example.test:0443/token", "https://example.test:0/token", "https://example.test:/token", "https://[fe80::1%25eth0]/token", "https://bad_host.test/token", "https://example.test:65536/token"} {
		t.Run(raw, func(t *testing.T) {
			_, err := NewTransport(Config{Endpoints: []Endpoint{{URL: raw}}})
			if !errors.Is(err, ErrPolicy) {
				t.Fatalf("ambiguous URL accepted: %v", err)
			}
			if strings.Contains(err.Error(), "secret") {
				t.Fatal("config URL leaked")
			}
		})
	}
	for _, e := range []Endpoint{
		{URL: "https://example.test/token", PrivateCIDRs: []netip.Prefix{netip.MustParsePrefix("0.0.0.0/0")}},
		{URL: "https://example.test/token", PrivateCIDRs: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/7")}},
		{URL: "https://example.test/token", TestLoopbackCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}},
		{URL: "https://127.0.0.1/token", TestLoopbackCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}},
		{URL: "https://example.test/token", ApprovedCIDRs: []netip.Prefix{netip.MustParsePrefix("::ffff:10.0.0.0/104")}},
		{URL: "https://example.test/token", ApprovedCIDRs: []netip.Prefix{{}}},
		{URL: "https://example.test/token", MaxResponseBytes: 1<<20 + 1},
	} {
		if _, err := NewTransport(Config{Endpoints: []Endpoint{e}}); !errors.Is(err, ErrPolicy) {
			t.Fatalf("broad policy accepted: %+v", e)
		}
	}
	for _, cfg := range []Config{{}, {Endpoints: []Endpoint{{URL: "https://example.test"}, {URL: "https://example.test"}}}, {Endpoints: []Endpoint{{URL: "https://example.test"}}, RequestTimeout: 11 * time.Second}, {Endpoints: []Endpoint{{URL: "https://example.test"}}, ConnectTimeout: -1}, {Endpoints: []Endpoint{{URL: "https://example.test"}}, HeaderTimeout: 6 * time.Second}, {Endpoints: []Endpoint{{URL: "https://example.test"}}, MaxRequestBytes: 64<<10 + 1}} {
		if _, err := NewTransport(cfg); !errors.Is(err, ErrPolicy) {
			t.Fatal("unbounded config accepted")
		}
	}
}

//nolint:bodyclose // Successful bodies are closed by readClose; rejection cases require no response.
func TestDNSAllAnswersReservedAndMappedForms(t *testing.T) {
	blocked := []string{"0.0.0.0", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.100.100.200", "168.63.129.16", "224.0.0.1", "240.1.1.1", "192.0.2.1", "198.18.0.1", "::", "::1", "fe80::1", "ff02::1", "fc00::1", "fec0::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "2001:db8::1", "2002:7f00:1::", "64:ff9b::7f00:1", "2001::1", "3fff::1", "fd00:ec2::254", "fd20:ce::254"}
	for _, ip := range blocked {
		t.Run(ip, func(t *testing.T) {
			var calls atomic.Int32
			c := client(t, Config{Endpoints: []Endpoint{{URL: "https://idp.example/token"}}, Resolver: resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
				return []netip.Addr{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr(ip)}, nil
			}), Dialer: dialerFunc(func(context.Context, string, string) (net.Conn, error) {
				calls.Add(1)
				return nil, errors.New("should never dial")
			})})
			if _, err := c.Do(request(t.Context(), t, http.MethodPost, "https://idp.example/token", strings.NewReader("TOP-SECRET"))); !errors.Is(err, ErrPolicy) {
				t.Fatalf("reserved address not rejected: %v", err)
			}
			if calls.Load() != 0 {
				t.Fatal("dialed before validating every DNS answer")
			}
		})
	}
	for _, answers := range [][]netip.Addr{nil, {netip.Addr{}}, make([]netip.Addr, 33)} {
		c := client(t, Config{Endpoints: []Endpoint{{URL: "https://idp.example/token"}}, Resolver: resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) { return answers, nil })})
		if _, err := c.Do(request(t.Context(), t, http.MethodGet, "https://idp.example/token", nil)); !errors.Is(err, ErrPolicy) {
			t.Fatal("invalid DNS answer accepted")
		}
	}
}

//nolint:bodyclose // Successful bodies are closed by readClose; rejection cases require no response.
func TestOnPremCIDRsRemainScopedAndProtected(t *testing.T) {
	p := &target{e: Endpoint{PrivateCIDRs: []netip.Prefix{netip.MustParsePrefix("10.20.0.0/16"), netip.MustParsePrefix("fd00::/8")}}}
	for _, ip := range []string{"10.20.1.2", "fd12::1", "::ffff:10.20.1.2"} {
		if !p.allows(netip.MustParseAddr(ip)) {
			t.Fatalf("narrow private policy refused %s", ip)
		}
	}
	for _, ip := range []string{"10.21.1.2", "127.0.0.1", "169.254.169.254", "::1", "fd00:ec2::254", "fd20:ce::254", "168.63.129.16"} {
		if p.allows(netip.MustParseAddr(ip)) {
			t.Fatalf("protected target permitted %s", ip)
		}
	}
	p.e.ApprovedCIDRs = []netip.Prefix{netip.MustParsePrefix("10.20.1.0/24")}
	if p.allows(netip.MustParseAddr("10.20.2.1")) {
		t.Fatal("approved range was ignored")
	}
}

// The trusted test dialer maps a pinned synthetic public/private TCP peer to an
// isolated local TLS fixture. This exercises hostname/CA verification as well as
// exact literal dialing without requiring external or on-prem network access.
func mapped(t *testing.T, s *httptest.Server, e Endpoint, ip string) (Endpoint, Resolver, Dialer) {
	t.Helper()
	_, port, err := net.SplitHostPort(s.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	e.URL = "https://example.com:" + port + "/endpoint"
	e.TestLoopbackCIDRs = nil
	a := netip.MustParseAddr(ip)
	resolver := resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) { return []netip.Addr{a}, nil })
	dialer := dialerFunc(func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != net.JoinHostPort(a.Unmap().String(), port) {
			t.Errorf("hostname was re-resolved: %s", address)
			return nil, ErrPolicy
		}
		conn, err := (&net.Dialer{}).DialContext(ctx, network, s.Listener.Addr().String())
		if err != nil {
			return nil, err
		}
		peer, err := net.ResolveTCPAddr("tcp", address)
		if err != nil {
			_ = conn.Close()
			return nil, err
		}
		return &peerConn{Conn: conn, peer: peer}, nil
	})
	return e, resolver, dialer
}

//nolint:bodyclose // Successful bodies are closed by readClose; rejection cases require no response.
func TestDNSRebindingEveryRequestAndActualPeer(t *testing.T) {
	s, e := fixture(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	e, _, d := mapped(t, s, e, "93.184.216.34")
	var lookups atomic.Int32
	var resolver Resolver = resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
		if lookups.Add(1) == 1 {
			return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
		}
		return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
	})
	c := client(t, Config{Endpoints: []Endpoint{e}, Resolver: resolver, Dialer: d})
	r, err := c.Do(request(t.Context(), t, http.MethodGet, e.URL, nil))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := readClose(t, r); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Do(request(t.Context(), t, http.MethodGet, e.URL, nil)); !errors.Is(err, ErrPolicy) {
		t.Fatalf("rebinding/reuse bypass: %v", err)
	}
	if lookups.Load() != 2 {
		t.Fatal("did not resolve each request")
	}
	// A lying/broken dialer cannot connect a different actual peer than the DNS
	// result; refusal occurs before TLS or request body transmission.
	e, resolver, _ = mapped(t, s, e, "93.184.216.34")
	bad := client(t, Config{Endpoints: []Endpoint{e}, Resolver: resolver, Dialer: dialerFunc(func(ctx context.Context, n, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, n, s.Listener.Addr().String())
	})})
	if _, err := bad.Do(request(t.Context(), t, http.MethodPost, e.URL, strings.NewReader("TOP-SECRET"))); !errors.Is(err, ErrPolicy) {
		t.Fatalf("actual peer bypass: %v", err)
	}
}

//nolint:bodyclose // Successful bodies are closed by readClose; rejection cases require no response.
func TestOnPremStillVerifiesHostnameAndCA(t *testing.T) {
	s, e := fixture(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	e, resolver, d := mapped(t, s, e, "10.20.1.2")
	e.PrivateCIDRs = []netip.Prefix{netip.MustParsePrefix("10.20.1.0/24")}
	c := client(t, Config{Endpoints: []Endpoint{e}, Resolver: resolver, Dialer: d})
	r, err := c.Do(request(t.Context(), t, http.MethodGet, e.URL, nil))
	if err != nil {
		t.Fatal(err)
	}
	_, err = readClose(t, r)
	if err != nil {
		t.Fatal(err)
	}
	e.RootCAs = x509.NewCertPool()
	badCA := client(t, Config{Endpoints: []Endpoint{e}, Resolver: resolver, Dialer: d})
	if _, err := badCA.Do(request(t.Context(), t, http.MethodGet, e.URL, nil)); !errors.Is(err, ErrNetwork) {
		t.Fatalf("on-prem bypassed CA: %v", err)
	}
	e.RootCAs = c.transport.targets[e.URL].e.RootCAs
	e.URL = strings.Replace(e.URL, "example.com", "wrong.example", 1)
	wrongName := client(t, Config{Endpoints: []Endpoint{e}, Resolver: resolver, Dialer: d})
	if _, err := wrongName.Do(request(t.Context(), t, http.MethodGet, e.URL, nil)); !errors.Is(err, ErrNetwork) {
		t.Fatalf("on-prem bypassed hostname: %v", err)
	}
}

//nolint:bodyclose // Successful bodies are closed by readClose; rejection cases require no response.
func TestRedirectProxyHostAndSecrets(t *testing.T) {
	var hits, proxyHits atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { proxyHits.Add(1) }))
	defer proxy.Close()
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"} {
		t.Setenv(key, proxy.URL)
	}
	t.Setenv("NO_PROXY", "")
	t.Setenv("no_proxy", "")
	s, e := fixture(t, func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.Header().Set("Location", "https://attacker.test?client_secret=TOP-SECRET")
		w.WriteHeader(http.StatusTemporaryRedirect)
	})
	c := client(t, Config{Endpoints: []Endpoint{e, {URL: s.URL + "/other", RootCAs: e.RootCAs, TestLoopbackCIDRs: e.TestLoopbackCIDRs}}})
	r, err := c.Do(request(t.Context(), t, http.MethodPost, e.URL, strings.NewReader("client_secret=TOP-SECRET")))
	if r != nil || !errors.Is(err, ErrRedirect) || strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("redirect error: %v", err)
	}
	if hits.Load() != 1 || proxyHits.Load() != 0 {
		t.Fatal("redirect/proxy was used")
	}
	req := request(t.Context(), t, http.MethodGet, e.URL, nil)
	req.Host = "attacker.test"
	if _, err := c.Do(req); !errors.Is(err, ErrPolicy) {
		t.Fatal("Host override accepted")
	}
	// Standard clients can use NewTransport; they must redact their own url.Error.
	rt, err := NewTransport(Config{Endpoints: []Endpoint{e}})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.CloseIdleConnections()
	std := &http.Client{Transport: rt}
	resp, err := std.Do(request(t.Context(), t, http.MethodPost, e.URL, strings.NewReader("TOP-SECRET")))
	if resp != nil {
		_ = resp.Body.Close()
	}
	if !errors.Is(err, ErrRedirect) {
		t.Fatalf("standard client followed redirect: %v", err)
	}
	e.URL += "?secret=TOP-SECRET"
	e.TestLoopbackCIDRs = nil
	redacted := client(t, Config{Endpoints: []Endpoint{e}, Dialer: dialerFunc(func(context.Context, string, string) (net.Conn, error) { return nil, errors.New("UPSTREAM-TOP-SECRET") })})
	if _, err := redacted.Do(request(t.Context(), t, http.MethodGet, e.URL, nil)); err == nil || strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("raw request error: %v", err)
	}
}

//nolint:bodyclose // Successful bodies are closed by readClose; rejection cases require no response.
func TestRequestResponseAndDecompressedLimits(t *testing.T) {
	for _, mode := range []string{"known", "chunked", "gzip"} {
		t.Run(mode, func(t *testing.T) {
			_, e := fixture(t, func(w http.ResponseWriter, _ *http.Request) {
				if mode == "gzip" {
					w.Header().Set("Content-Encoding", "gzip")
					z := gzip.NewWriter(w)
					_, _ = z.Write([]byte(strings.Repeat("x", 100)))
					_ = z.Close()
					return
				}
				if mode == "known" {
					w.Header().Set("Content-Length", "100")
				}
				if mode == "chunked" {
					w.(http.Flusher).Flush()
				}
				_, _ = io.WriteString(w, strings.Repeat("x", 100))
			})
			e.MaxResponseBytes = 8
			c := client(t, Config{Endpoints: []Endpoint{e}})
			r, err := c.Do(request(t.Context(), t, http.MethodGet, e.URL, nil))
			if r != nil {
				data, bodyErr := readClose(t, r)
				if len(data) > 8 {
					t.Fatal("excess bytes exposed")
				}
				err = bodyErr
			}
			if !errors.Is(err, ErrTooLarge) {
				t.Fatalf("unbounded %s response: %v", mode, err)
			}
		})
	}
	_, e := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, "ok")
	})
	c := client(t, Config{Endpoints: []Endpoint{e}, MaxRequestBytes: 8})
	for _, unknown := range []bool{false, true} {
		req := request(t.Context(), t, http.MethodPost, e.URL, strings.NewReader("TOP-SECRET-OVER-LIMIT"))
		if unknown {
			req.ContentLength = -1
		}
		r, err := c.Do(req)
		if r != nil {
			_ = r.Body.Close()
		}
		if !errors.Is(err, ErrTooLarge) || strings.Contains(err.Error(), "SECRET") {
			t.Fatalf("request limit: %v", err)
		}
	}
	_, e = fixture(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "12345678") })
	e.MaxResponseBytes = 8
	exact := client(t, Config{Endpoints: []Endpoint{e}})
	r, err := exact.Do(request(t.Context(), t, http.MethodGet, e.URL, nil))
	if err != nil {
		t.Fatal(err)
	}
	data, err := readClose(t, r)
	if err != nil || string(data) != "12345678" {
		t.Fatalf("exact limit: %q %v", data, err)
	}
}

//nolint:bodyclose // Successful bodies are closed by readClose; rejection cases require no response.
func TestCancellationAndTimeouts(t *testing.T) {
	t.Run("resolver", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		started := make(chan struct{})
		c := client(t, Config{Endpoints: []Endpoint{{URL: "https://idp.test/token"}}, Resolver: resolverFunc(func(ctx context.Context, _, _ string) ([]netip.Addr, error) {
			close(started)
			<-ctx.Done()
			return nil, ctx.Err()
		})})
		done := make(chan error, 1)
		go func() {
			_, err := c.Do(request(ctx, t, http.MethodPost, "https://idp.test/token", strings.NewReader("TOP-SECRET")))
			done <- err
		}()
		<-started
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatalf("context: %v", err)
		}
	})
	t.Run("connect", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		started := make(chan struct{})
		c := client(t, Config{Endpoints: []Endpoint{{URL: "https://93.184.216.34/token"}}, Dialer: dialerFunc(func(ctx context.Context, _, _ string) (net.Conn, error) {
			close(started)
			<-ctx.Done()
			return nil, ctx.Err()
		})})
		done := make(chan error, 1)
		go func() {
			_, err := c.Do(request(ctx, t, http.MethodGet, "https://93.184.216.34/token", nil))
			done <- err
		}()
		<-started
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatalf("context: %v", err)
		}
	})
	t.Run("clock", func(t *testing.T) {
		clock := clockFunc(func(parent context.Context, _ time.Duration) (context.Context, context.CancelFunc) {
			ctx, cancel := context.WithCancel(parent)
			cancel()
			return ctx, cancel
		})
		c := client(t, Config{Endpoints: []Endpoint{{URL: "https://93.184.216.34/token"}}, Clock: clock})
		if _, err := c.Do(request(t.Context(), t, http.MethodGet, "https://93.184.216.34/token", nil)); !errors.Is(err, context.Canceled) {
			t.Fatalf("injected clock: %v", err)
		}
	})
	t.Run("headers", func(t *testing.T) {
		_, e := fixture(t, func(_ http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
		c := client(t, Config{Endpoints: []Endpoint{e}, HeaderTimeout: 20 * time.Millisecond})
		if _, err := c.Do(request(t.Context(), t, http.MethodGet, e.URL, nil)); err == nil {
			t.Fatal("unbounded header wait")
		}
	})
	t.Run("body", func(t *testing.T) {
		_, e := fixture(t, func(w http.ResponseWriter, r *http.Request) { w.(http.Flusher).Flush(); <-r.Context().Done() })
		c := client(t, Config{Endpoints: []Endpoint{e}, RequestTimeout: 40 * time.Millisecond})
		r, err := c.Do(request(t.Context(), t, http.MethodGet, e.URL, nil))
		if err != nil {
			t.Fatal(err)
		}
		_, err = readClose(t, r)
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("body timeout: %v", err)
		}
	})
}

//nolint:bodyclose // Successful bodies are closed by readClose; rejection cases require no response.
func TestConcurrentClientAndImmutableConfig(t *testing.T) {
	_, e := fixture(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	cfg := Config{Endpoints: []Endpoint{e}}
	c := client(t, cfg)
	cfg.Endpoints[0].URL = "https://attacker.test"
	cfg.Endpoints[0].TestLoopbackCIDRs[0] = netip.MustParsePrefix("::1/128")
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			r, err := c.Do(request(t.Context(), t, http.MethodGet, e.URL, nil))
			if err != nil {
				t.Error(err)
				return
			}
			if _, err := readClose(t, r); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
}

type failingReader struct{ err error }

func (f failingReader) Read([]byte) (int, error) { return 0, f.err }
func (f failingReader) Close() error             { return f.err }

//nolint:bodyclose // These requests assert rejection before any response is returned.
func TestSecretSafeDNSDialAndBodyErrors(t *testing.T) {
	url := "https://idp.example/token?client_secret=QUERY-SECRET"
	for name, cfg := range map[string]Config{
		"dns":  {Endpoints: []Endpoint{{URL: url}}, Resolver: resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) { return nil, errors.New("DNS-SECRET") })},
		"dial": {Endpoints: []Endpoint{{URL: "https://93.184.216.34/token?secret=QUERY-SECRET"}}, Dialer: dialerFunc(func(context.Context, string, string) (net.Conn, error) { return nil, errors.New("DIAL-SECRET") })},
	} {
		t.Run(name, func(t *testing.T) {
			c := client(t, cfg)
			_, err := c.Do(request(t.Context(), t, http.MethodPost, cfg.Endpoints[0].URL, strings.NewReader("BODY-SECRET")))
			if !errors.Is(err, ErrNetwork) || strings.Contains(err.Error(), "SECRET") {
				t.Fatalf("unsafe error: %v", err)
			}
		})
	}
	for _, err := range []error{errors.New("BODY-SECRET"), fmt.Errorf("BODY-SECRET: %w", io.EOF), fmt.Errorf("BODY-SECRET: %w", context.Canceled)} {
		b := &limitedBody{body: failingReader{err}, ctx: t.Context(), remaining: 8}
		_, got := io.ReadAll(b)
		if got != nil && strings.Contains(got.Error(), "SECRET") {
			t.Fatalf("body error leaked: %v", got)
		}
		if closeErr := b.Close(); closeErr != nil {
			t.Fatalf("close leaked: %v", closeErr)
		}
	}
}

//nolint:bodyclose // Successful bodies are closed by readClose.
func TestLiteralIPv6TestExceptionRequiresTLS(t *testing.T) {
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp6", "[::1]:0")
	if err != nil {
		t.Skip("IPv6 loopback unavailable:", err)
	}
	s := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	s.Listener = listener
	s.Config.ErrorLog = log.New(io.Discard, "", 0)
	s.StartTLS()
	defer s.Close()
	pool := x509.NewCertPool()
	pool.AddCert(s.Certificate())
	e := Endpoint{URL: s.URL + "/endpoint", RootCAs: pool, TestLoopbackCIDRs: []netip.Prefix{netip.MustParsePrefix("::1/128")}}
	c := client(t, Config{Endpoints: []Endpoint{e}})
	r, err := c.Do(request(t.Context(), t, http.MethodGet, e.URL, nil))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := readClose(t, r); err != nil {
		t.Fatal(err)
	}
}

//nolint:bodyclose // A response header budget rejection returns no response.
func TestHeaderByteBudget(t *testing.T) {
	_, e := fixture(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Padding", strings.Repeat("x", 64<<10))
		_, _ = io.WriteString(w, "ok")
	})
	c := client(t, Config{Endpoints: []Endpoint{e}})
	if _, err := c.Do(request(t.Context(), t, http.MethodGet, e.URL, nil)); !errors.Is(err, ErrNetwork) {
		t.Fatalf("unbounded headers: %v", err)
	}
}
