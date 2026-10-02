package webhook

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// referenceVerify is the receiver check as docs/19 describes it, written independently of
// Sign: hex HMAC-SHA256(secret, "<timestamp>.<body>"), "v1=" prefix, ±5 minutes.
func referenceVerify(secret string, h http.Header, body []byte, now time.Time) bool {
	ts := h.Get("X-Calab-Timestamp")
	n, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || now.Unix()-n > 300 || n-now.Unix() > 300 {
		return false
	}
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(ts + "." + string(body)))
	return hmac.Equal([]byte(h.Get("X-Calab-Signature")), []byte("v1="+hex.EncodeToString(m.Sum(nil))))
}

func TestSignV1(t *testing.T) {
	secret, body := "0123456789abcdef-secret", []byte(`{"id":"d1","type":"task.updated"}`)
	now := time.Unix(1_790_000_000, 0)
	h := http.Header{}
	h.Set(HeaderTimestamp, strconv.FormatInt(now.Unix(), 10))
	h.Set(HeaderSignature, Sign([]byte(secret), now.Unix(), body))
	if !referenceVerify(secret, h, body, now) {
		t.Fatalf("the reference verifier rejects %s", h.Get(HeaderSignature))
	}
	if err := Verify([]byte(secret), h, body, now.Add(4*time.Minute)); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	for name, c := range map[string]struct {
		secret string
		body   []byte
		now    time.Time
	}{
		"other secret": {"another-secret-16chars", body, now},
		"other body":   {secret, []byte(`{"id":"d2"}`), now},
		"replayed":     {secret, body, now.Add(6 * time.Minute)},
		"from future":  {secret, body, now.Add(-6 * time.Minute)},
	} {
		if referenceVerify(c.secret, h, c.body, c.now) || Verify([]byte(c.secret), h, c.body, c.now) == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestBackoff(t *testing.T) {
	for attempt, want := range map[int32]time.Duration{0: time.Minute, 1: 2 * time.Minute, 5: 32 * time.Minute, 6: time.Hour, 60: time.Hour} {
		if got := Backoff(attempt); got != want {
			t.Errorf("Backoff(%d) = %v, want %v", attempt, got, want)
		}
	}
}

// SSRF: https only, no credentials, no loopback / private / link-local literals, no localhost.
func TestCheckURLPolicy(t *testing.T) {
	tr := NewTransport(Options{}) // production policy
	for _, bad := range []string{
		"http://example.com/hook", "https://user:pw@example.com/hook",
		"https://10.0.0.1/hook", "https://192.168.1.1/hook", "https://127.0.0.1:8443/hook", "https://[::1]/hook",
		"https://169.254.169.254/latest", "https://[::ffff:127.0.0.1]/x", "https://localhost/hook", "https://api.localhost/hook",
		"ftp://example.com", "example.com/hook", "", "https://example.com/" + strings.Repeat("a", MaxURL),
	} {
		if _, err := tr.CheckURL(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	for _, ok := range []string{"https://example.com/hook", "https://8.8.8.8/x?y=1", "https://hooks.example.org:8443/calab"} {
		if _, err := tr.CheckURL(ok); err != nil {
			t.Errorf("rejected %q: %v", ok, err)
		}
	}
}

// Loopback is refused before dialing, by literal address and by "localhost".
func TestPostRefusesLoopback(t *testing.T) {
	ts := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer ts.Close()
	pool := x509.NewCertPool()
	pool.AddCert(ts.Certificate())
	tr := NewTransport(Options{RootCAs: pool}) // production address policy
	port := ts.URL[strings.LastIndex(ts.URL, ":")+1:]
	for _, u := range []string{ts.URL, "https://localhost:" + port} {
		if _, err := tr.Post(context.Background(), u, []byte("{}"), nil); !errors.Is(err, ErrNotAllowed) {
			t.Fatalf("%s: %v", u, err)
		}
	}
}

// A redirect is an answer, not a success, and is never followed.
func TestPostDoesNotFollowRedirects(t *testing.T) {
	var hits sync.Map
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Store(r.URL.Path, true)
		if r.URL.Path == "/hook" {
			http.Redirect(w, r, "/internal", http.StatusFound)
		}
	}))
	defer ts.Close()
	pool := x509.NewCertPool()
	pool.AddCert(ts.Certificate())
	tr := NewTransport(Options{RootCAs: pool, AllowAddr: func(netip.Addr) bool { return true }})
	status, err := tr.Post(context.Background(), ts.URL+"/hook", []byte("{}"), http.Header{"X-Test": {"1"}})
	if err == nil || status != http.StatusFound || err.Error() != "HTTP 302" {
		t.Fatalf("redirect: %d %v", status, err)
	}
	if _, followed := hits.Load("/internal"); followed {
		t.Fatal("the redirect was followed")
	}
	if _, err := NewTransport(Options{RootCAs: pool, AllowAddr: func(netip.Addr) bool { return true }}).
		Post(context.Background(), strings.Replace(ts.URL, "https", "http", 1), nil, nil); !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("http: %v", err)
	}
}

// ---- the worker over a fake queue ----

type fakeQueue struct {
	mu        sync.Mutex
	rows      map[uuid.UUID]*fakeRow
	target    Target
	gone      bool
	failing   *time.Time
	ok        int
	disabled  int
	delivered []uuid.UUID
}

type fakeRow struct {
	d                Delivery
	next             time.Time
	done, failed     bool
	attempts         int32
	lastErr, failed2 string
}

func (q *fakeQueue) Claim(_ context.Context, lease time.Duration, limit int32) ([]Delivery, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	var out []Delivery
	now := time.Now()
	for _, r := range q.rows {
		if !r.done && !r.failed && !r.next.After(now) && len(out) < int(limit) {
			r.next = now.Add(lease)
			d := r.d
			d.Attempts = r.attempts
			out = append(out, d)
		}
	}
	return out, nil
}

func (q *fakeQueue) Target(context.Context, uuid.UUID) (Target, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.target, !q.gone
}

func (q *fakeQueue) Headers(d Delivery, t Target, now time.Time) http.Header {
	h := http.Header{}
	h.Set("X-Calab-Delivery", d.ID.String())
	h.Set(HeaderTimestamp, strconv.FormatInt(now.Unix(), 10))
	h.Set(HeaderSignature, Sign(t.Secret, now.Unix(), d.Payload))
	return h
}

func (q *fakeQueue) Delivered(_ context.Context, d Delivery) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	r := q.rows[d.ID]
	r.done, r.attempts = true, r.attempts+1
	q.delivered = append(q.delivered, d.ID)
	q.ok++
	q.failing = nil
	return nil
}

func (q *fakeQueue) Retry(_ context.Context, d Delivery, next time.Time, msg string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	r := q.rows[d.ID]
	r.next, r.lastErr, r.attempts = next, msg, r.attempts+1
	return nil
}

func (q *fakeQueue) Failed(_ context.Context, d Delivery, msg string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	r := q.rows[d.ID]
	r.failed, r.failed2, r.attempts = true, msg, r.attempts+1
	return nil
}

func (q *fakeQueue) Failing(context.Context, uuid.UUID, string) (*time.Time, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.failing == nil {
		now := time.Now()
		q.failing = &now
	}
	return q.failing, nil
}

func (q *fakeQueue) Disable(context.Context, uuid.UUID) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.disabled++
	q.gone = true
	for _, r := range q.rows {
		if !r.done {
			r.failed = true
		}
	}
}

func (q *fakeQueue) Cleanup(context.Context, time.Time) error { return nil }

func (q *fakeQueue) add(payload string) uuid.UUID {
	q.mu.Lock()
	defer q.mu.Unlock()
	id := uuid.New()
	q.rows[id] = &fakeRow{d: Delivery{ID: id, Owner: uuid.Nil, Event: "e", Payload: []byte(payload), CreatedAt: time.Now()}}
	return id
}

// Delivered with the signature; failures retried with the backoff, dropped after GiveUp, and
// the webhook disabled once it failed for GiveUp.
func TestWorkerRetriesAndDisables(t *testing.T) {
	secret := "worker-secret-0123456789"
	var (
		mu     sync.Mutex
		fail   bool
		bodies []string
		bad    int
	)
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(b)
		mu.Lock()
		defer mu.Unlock()
		if !referenceVerify(secret, r.Header, b, time.Now()) || r.Header.Get("Content-Type") != "application/json" {
			bad++
		}
		bodies = append(bodies, string(b))
		if fail {
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer ts.Close()
	pool := x509.NewCertPool()
	pool.AddCert(ts.Certificate())
	o := Options{RootCAs: pool, AllowAddr: func(netip.Addr) bool { return true },
		Backoff: func(int32) time.Duration { return 50 * time.Millisecond }, GiveUp: 400 * time.Millisecond}
	q := &fakeQueue{rows: map[uuid.UUID]*fakeRow{}, target: Target{URL: ts.URL + "/hook", Secret: []byte(secret)}}
	w := NewWorker(q, NewTransport(o), nil, "test:webhook", o)
	ctx := context.Background()

	q.add(`{"n":1}`)
	if n, err := w.Process(ctx); err != nil || n != 1 {
		t.Fatalf("Process = %d, %v", n, err)
	}
	mu.Lock()
	if len(bodies) != 1 || bodies[0] != `{"n":1}` || bad != 0 {
		t.Fatalf("delivered %v, bad signatures %d", bodies, bad)
	}
	fail = true
	mu.Unlock()

	id := q.add(`{"n":2}`)
	deadline := time.Now().Add(5 * time.Second)
	for q.disabledCount() == 0 && time.Now().Before(deadline) {
		if _, err := w.Process(ctx); err != nil {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	r := q.rows[id]
	if q.disabled != 1 || !r.failed || r.attempts < 3 || r.lastErr != "HTTP 500" {
		t.Fatalf("disabled %d, row %+v", q.disabled, r)
	}
}

func (q *fakeQueue) disabledCount() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.disabled
}

// A delivery of a removed webhook is dropped without a request.
func TestWorkerDropsRemoved(t *testing.T) {
	q := &fakeQueue{rows: map[uuid.UUID]*fakeRow{}, gone: true}
	id := q.add(`{}`)
	w := NewWorker(q, NewTransport(Options{}), nil, "test:webhook", Options{})
	if n, err := w.Process(context.Background()); err != nil || n != 0 {
		t.Fatalf("Process = %d, %v", n, err)
	}
	if r := q.rows[id]; !r.failed || r.failed2 != "webhook removed or disabled" {
		t.Fatalf("row %+v", r)
	}
}
