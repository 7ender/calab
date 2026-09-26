//go:build integration

package app_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

// freezableProxy forwards TCP to Redis; once frozen it stops passing replies back, which
// looks to the client like a Redis that accepted the commands and hangs.
type freezableProxy struct {
	ln     net.Listener
	frozen atomic.Bool
	mu     sync.Mutex
	conns  []net.Conn
}

func newFreezableProxy(t *testing.T, upstream string) *freezableProxy {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &freezableProxy{ln: ln}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			u, err := (&net.Dialer{}).DialContext(context.Background(), "tcp", upstream)
			if err != nil {
				_ = c.Close()
				continue
			}
			p.mu.Lock()
			p.conns = append(p.conns, c, u)
			p.mu.Unlock()
			go func() { _, _ = io.Copy(u, c) }()
			go func() {
				buf := make([]byte, 32<<10)
				for {
					n, err := u.Read(buf)
					for p.frozen.Load() {
						time.Sleep(10 * time.Millisecond) // withhold the reply
					}
					if n > 0 {
						if _, werr := c.Write(buf[:n]); werr != nil {
							return
						}
					}
					if err != nil {
						return
					}
				}
			}()
		}
	}()
	t.Cleanup(func() {
		p.frozen.Store(false)
		_ = ln.Close()
		p.mu.Lock()
		for _, c := range p.conns {
			_ = c.Close()
		}
		p.mu.Unlock()
	})
	return p
}

// A reorder of many rooms while Redis hangs: the handler answers within one request budget
// (events.RequestBudget) instead of waiting a publish timeout per room (50 × 3 s before).
func TestReorderWithHungRedisIsBounded(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	wid := ws.GetId()
	const n = 50
	var order v1.SetRoomOrderRequest
	for i := range n {
		id := voiceRoom(t, o, wid, fmt.Sprintf("r%02d", i), 0)
		order.Rooms = append(order.Rooms, &v1.SetRoomOrderRequest_RoomPosition{RoomId: id, Position: int32(n - i)}) //nolint:gosec // small
	}

	opt, err := rueidis.ParseURL(testRedisURL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := newFreezableProxy(t, opt.InitAddress[0])
	opt.InitAddress = []string{proxy.ln.Addr().String()}
	opt.DisableRetry = true
	rc, err := rueidis.NewClient(opt)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	proxy.frozen.Store(true)

	uid, sid := uuid.MustParse(o.id), uuid.MustParse(o.session)
	wrap := func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := perm.WithResolver(auth.WithIdentity(r.Context(), auth.Identity{UserID: uid, SessionID: sid}), testDB.Q)
			h.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	mux := http.NewServeMux()
	rooms.NewHandlers(testDB, events.Redis{C: rc}).CategoryRoutes(mux, wrap)
	handler := events.Middleware(mux)

	body, err := protojson.Marshal(&order)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "/api/workspaces/"+wid+"/rooms/order", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	start := time.Now()
	go func() { handler.ServeHTTP(rec, req); close(done) }()
	limit := events.RequestBudget + 2*time.Second
	select {
	case <-done:
	case <-time.After(limit):
		t.Fatalf("reorder of %d rooms with a hung Redis still running after %v", n, limit)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	t.Logf("answered in %v", time.Since(start).Round(time.Millisecond))
}
