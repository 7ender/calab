package httpx

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

func TestClientIP(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32"), netip.MustParsePrefix("10.0.0.0/8")}
	cases := []struct {
		name, remote, xff, want string
	}{
		{"direct, no xff", "203.0.113.5:1234", "", "203.0.113.5"},
		{"untrusted peer spoofs xff", "203.0.113.5:1234", "1.2.3.4", "203.0.113.5"},
		{"trusted proxy", "127.0.0.1:1234", "198.51.100.7", "198.51.100.7"},
		{"client-supplied prefix ignored", "127.0.0.1:1234", "1.2.3.4, 198.51.100.7", "198.51.100.7"},
		{"chain of trusted proxies", "127.0.0.1:1234", "198.51.100.7, 10.1.2.3", "198.51.100.7"},
		{"garbage xff", "127.0.0.1:1234", "nonsense", "127.0.0.1"},
		{"ipv6 peer", "[2001:db8::1]:443", "", "2001:db8::1"},
	}
	for _, c := range cases {
		var got string
		h := WithClientIP(trusted)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { got = ClientIP(r.Context()) }))
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil)
		req.RemoteAddr = c.remote
		if c.xff != "" {
			req.Header.Set("X-Forwarded-For", c.xff)
		}
		h.ServeHTTP(httptest.NewRecorder(), req)
		if got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestWriteErrorMapsStatus(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteError(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil), Validation("slug", "bad"))
	if rec.Code != http.StatusUnprocessableEntity || rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("status %d", rec.Code)
	}
	if body := rec.Body.String(); body != `{"code":"ERROR_CODE_VALIDATION","message":"bad","field":"slug"}` &&
		body != `{"code":"ERROR_CODE_VALIDATION", "message":"bad", "field":"slug"}` {
		t.Fatalf("body %s", body)
	}
	rec = httptest.NewRecorder()
	WriteError(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil), http.ErrBodyNotAllowed)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("unknown error mapped to %d", rec.Code)
	}
}

// A request the client abandoned (its context is canceled) is not a server failure: 499,
// no ERROR log, no 5xx in metrics. A context.Canceled from the server's own work while the
// client is still there stays a 500.
func TestClientCanceledIsNotAServerError(t *testing.T) {
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(prev)

	mux := http.NewServeMux()
	mux.Handle("POST /cancel-test", HandlerFunc(func(_ http.ResponseWriter, r *http.Request) error {
		return fmt.Errorf("insert message: %w", r.Context().Err())
	}))
	mux.Handle("POST /server-cancel-test", HandlerFunc(func(http.ResponseWriter, *http.Request) error {
		return fmt.Errorf("db: %w", context.Canceled) // e.g. an internal timeout; the client waits
	}))
	h := Observe(mux)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the client went away
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequestWithContext(ctx, http.MethodPost, "/cancel-test", nil))
	if rec.Code != StatusClientClosed {
		t.Fatalf("client-canceled request: status %d, want 499", rec.Code)
	}
	if strings.Contains(logs.String(), `"level":"ERROR"`) {
		t.Fatalf("client cancel logged as an error: %s", logs.String())
	}
	if !strings.Contains(logs.String(), "request canceled by the client") {
		t.Fatal("client cancel not logged at debug level")
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/server-cancel-test", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("server-side cancel: status %d, want 500", rec.Code)
	}

	statuses := map[string]string{}
	mfs, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != "calaba_http_request_duration_seconds" {
			continue
		}
		for _, m := range mf.GetMetric() {
			var route, status string
			for _, l := range m.GetLabel() {
				switch l.GetName() {
				case "route":
					route = l.GetValue()
				case "status":
					status = l.GetValue()
				}
			}
			if strings.HasSuffix(route, "cancel-test") {
				statuses[route] += status + " "
			}
		}
	}
	if statuses["/cancel-test"] != "499 " || statuses["/server-cancel-test"] != "500 " {
		t.Fatalf("metric statuses: %v", statuses)
	}
}
