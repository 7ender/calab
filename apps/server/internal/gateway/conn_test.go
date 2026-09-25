package gateway

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// B3: while held, the stash shares the send queue budget; exceeding it closes with 4008.
func TestHeldStashOverflowCloses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c := newConn(ws, codec{})
		c.hold()
		go c.writeLoop()
		for i := 0; i < 3*sendQueue; i++ {
			c.mu.Lock()
			closed := c.closed
			c.mu.Unlock()
			if closed {
				break
			}
			c.send(websocket.MessageBinary, []byte{1})
			time.Sleep(10 * time.Microsecond)
		}
		<-c.ctx.Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ws.CloseNow() }()
	n := 0
	for {
		_, _, err := ws.Read(ctx)
		if err != nil {
			var ce websocket.CloseError
			if !errors.As(err, &ce) || ce.Code != websocket.StatusCode(v1.GatewayCloseCode_GATEWAY_CLOSE_CODE_RATE_LIMITED) {
				t.Fatalf("want close 4008, got %v", err)
			}
			break
		}
		n++
	}
	if n != 0 {
		t.Fatalf("held conn wrote %d messages before closing", n)
	}
}

// B4: a real status change passes the soft limit, a repeat does not.
func TestPresenceSoftExempt(t *testing.T) {
	s := testSession()
	s.status = v1.PresenceStatus_PRESENCE_STATUS_ONLINE
	pres := func(st v1.PresenceStatus) *v1.GatewayFrame {
		return &v1.GatewayFrame{Payload: &v1.GatewayFrame_SetPresence{SetPresence: &v1.SetPresence{Status: st}}}
	}
	if softExempt(s, pres(v1.PresenceStatus_PRESENCE_STATUS_ONLINE)) {
		t.Fatal("repeated status must be subject to the soft limit")
	}
	if !softExempt(s, pres(v1.PresenceStatus_PRESENCE_STATUS_DND)) {
		t.Fatal("changed status must pass")
	}
	if !softExempt(s, &v1.GatewayFrame{Payload: &v1.GatewayFrame_Heartbeat{Heartbeat: &v1.Heartbeat{}}}) {
		t.Fatal("heartbeat must pass")
	}
	if softExempt(s, &v1.GatewayFrame{Payload: &v1.GatewayFrame_Typing{Typing: &v1.Typing{}}}) {
		t.Fatal("typing is soft-limited")
	}
}
