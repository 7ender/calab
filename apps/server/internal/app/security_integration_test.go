//go:build integration

package app_test

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/redisx"
)

// strictServer runs a second app on the same DB/Redis with small abuse limits.
func strictServer(t *testing.T, maxTotal int64) *httptest.Server {
	t.Helper()
	cfg := *testCfg
	cfg.MaxWorkspacesPerUser, cfg.WorkspaceCreatesPerHour, cfg.LoginAccountBurst = 2, 3, 3
	cfg.DefaultWorkspaceQuotaBytes, cfg.StorageMaxTotalBytes = 12345, maxTotal
	a := app.New(app.Deps{Config: &cfg, DB: testDB, Redis: testRedis, Events: events.Redis{C: testRedis}, Blob: testStore, LiveKit: lkRec})
	s := httptest.NewServer(a.Handler)
	t.Cleanup(s.Close)
	return s
}

type result struct {
	StatusCode int
	Header     http.Header
}

func reqTo(t *testing.T, base, method, path, token, ip string, body string) (result, string) {
	t.Helper()
	var rd *strings.Reader
	if body == "" {
		rd = strings.NewReader("")
	} else {
		rd = strings.NewReader(body)
	}
	req, _ := http.NewRequestWithContext(context.Background(), method, base+path, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("X-Forwarded-For", ip)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b := new(bytes.Buffer)
	_, _ = b.ReadFrom(resp.Body)
	return result{StatusCode: resp.StatusCode, Header: resp.Header}, b.String()
}

func TestAbuseLimits(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	a := register(t, invite(t, o, ws.GetId()))
	var total int64
	if err := testDB.Pool.QueryRow(context.Background(),
		"SELECT (SELECT coalesce(sum(storage_used_bytes),0) FROM workspaces) + (SELECT coalesce(sum(size),0) FROM files WHERE workspace_id IS NULL)").Scan(&total); err != nil {
		t.Fatal(err)
	}
	s := strictServer(t, total+100)

	// Workspace limit (2) and creation rate (3 per hour).
	var codes []int
	var quota string
	for i := range 4 {
		resp, body := reqTo(t, s.URL, "POST", "/api/workspaces", a.token, "10.70.0.1", `{"slug":"lim-`+uniq("")+`","name":"L"}`)
		codes = append(codes, resp.StatusCode)
		if i == 0 {
			quota = body
		}
		if i == 2 && !strings.Contains(body, "ERROR_CODE_WORKSPACE_LIMIT") {
			t.Fatalf("3rd create: %s", body)
		}
		if i == 3 && resp.Header.Get("Retry-After") == "" {
			t.Fatal("429 without Retry-After")
		}
	}
	if codes[0] != 201 || codes[1] != 201 || codes[2] != 409 || codes[3] != 429 {
		t.Fatalf("create codes %v, want [201 201 409 429]", codes)
	}
	if !strings.Contains(quota, `"storageQuotaBytes":"12345"`) {
		t.Fatalf("DEFAULT_WORKSPACE_QUOTA_BYTES not applied: %s", quota)
	}

	// Server-wide storage cap: 507 STORAGE_FULL.
	var mb bytes.Buffer
	mw := multipart.NewWriter(&mb)
	fw, _ := mw.CreateFormFile("file", "a.bin")
	_, _ = fw.Write(bytes.Repeat([]byte("z"), 500))
	_ = mw.Close()
	req, _ := http.NewRequestWithContext(context.Background(), "POST", s.URL+"/api/workspaces/"+ws.GetId()+"/files", &mb)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+a.token)
	up, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = up.Body.Close()
	if up.StatusCode != http.StatusInsufficientStorage {
		t.Fatalf("upload over the global cap: %d", up.StatusCode)
	}

	// Login attempts per account (3 here), from any IP; the correct password is refused too.
	email := mustEmail(t, a)
	for i := range 3 {
		resp, _ := reqTo(t, s.URL, "POST", "/api/auth/login", "", "10.71.0."+string(rune('1'+i)), `{"email":"`+email+`","password":"wrong-password"}`)
		if resp.StatusCode != 401 {
			t.Fatalf("attempt %d: %d", i, resp.StatusCode)
		}
	}
	resp, _ := reqTo(t, s.URL, "POST", "/api/auth/login", "", "10.71.0.9", `{"email":"`+strings.ToUpper(email)+`","password":"password123"}`)
	if resp.StatusCode != 429 || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("4th attempt from a new IP: %d retry-after=%q", resp.StatusCode, resp.Header.Get("Retry-After"))
	}
}

func TestLimiterFailsClosed(t *testing.T) {
	c, err := redisx.Connect(context.Background(), env("TEST_REDIS_URL", "redis://localhost:56379/15"))
	if err != nil {
		t.Fatal(err)
	}
	l := redisx.NewRateLimiter(c, "rl:test:", 5, 60)
	if err := l.Take(context.Background(), "k"); err != nil {
		t.Fatalf("healthy: %v", err)
	}
	c.Close()
	err = l.Take(context.Background(), "k")
	if e := httpx.AsError(err); err == nil || e.Status != http.StatusServiceUnavailable {
		t.Fatalf("Redis down: %v, want 503", err)
	}
	_ = rueidis.Nil
}

func TestAPIHeadersAndNullOrigin(t *testing.T) {
	o := owner(t)
	resp, _ := reqTo(t, srv.URL, "GET", "/api/me", o.token, "10.72.0.1", "")
	if resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("API headers: %v", resp.Header)
	}
	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/gateway"
	dial := func(h http.Header) int {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		ws, r, _ := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: h})
		if ws != nil {
			_ = ws.CloseNow()
		}
		if r == nil {
			return 0
		}
		if r.Body != nil {
			_ = r.Body.Close()
		}
		return r.StatusCode
	}
	if st := dial(http.Header{"Origin": {"null"}}); st != 101 {
		t.Fatalf("null origin without cookies (desktop): %d", st)
	}
	if st := dial(http.Header{"Origin": {"null"}, "Cookie": {"a=b"}}); st != 403 {
		t.Fatalf("null origin with cookies: %d", st)
	}
}
