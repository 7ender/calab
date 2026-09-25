package gateway

import (
	"context"
	"sync"
	"time"

	"github.com/coder/websocket"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Socket limits (docs/05 "Защита соединения").
const (
	readLimit    = 64 << 10
	sendQueue    = 256
	writeTimeout = 10 * time.Second
)

type outMsg struct {
	typ   websocket.MessageType
	data  []byte
	close websocket.StatusCode // non-zero: close the socket after previous messages
	why   string
}

// conn is one WebSocket. All writes go through a single writer goroutine and a bounded
// queue: a slow client can never block fan-out; overflow closes it with 4008.
type conn struct {
	ws     *websocket.Conn
	codec  codec
	out    chan outMsg
	ctx    context.Context
	cancel context.CancelFunc

	mu           sync.Mutex
	closed       bool
	serverClosed bool     // we initiated the close; session fate already decided
	replay       []outMsg // written before anything from out (RESUME)
	wake         chan struct{}
}

func newConn(ws *websocket.Conn, c codec) *conn {
	ctx, cancel := context.WithCancel(context.Background())
	return &conn{ws: ws, codec: c, out: make(chan outMsg, sendQueue), ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1)}
}

// writeLoop writes queued messages. Replay frames (set by setReplay) always go out before
// any message taken from the queue, so a resumed client sees events in seq order.
func (c *conn) writeLoop() {
	defer c.cancel()
	for {
		var next *outMsg
		select {
		case <-c.ctx.Done():
			return
		case <-c.wake:
		case m := <-c.out:
			next = &m
		}
		c.mu.Lock()
		replay := c.replay
		c.replay = nil
		c.mu.Unlock()
		for _, m := range replay {
			if !c.write(m) {
				return
			}
		}
		if next != nil && !c.write(*next) {
			return
		}
	}
}

// setReplay queues frames that must precede everything already or later enqueued.
func (c *conn) setReplay(ms []outMsg) {
	c.mu.Lock()
	c.replay = append(c.replay, ms...)
	c.mu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *conn) write(m outMsg) bool {
	if m.close != 0 {
		_ = c.ws.Close(m.close, m.why)
		return false
	}
	ctx, cancel := context.WithTimeout(c.ctx, writeTimeout)
	defer cancel()
	if err := c.ws.Write(ctx, m.typ, m.data); err != nil {
		_ = c.ws.CloseNow()
		return false
	}
	return true
}

// send enqueues without blocking; a full queue closes the socket with 4008.
func (c *conn) send(typ websocket.MessageType, b []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	select {
	case c.out <- outMsg{typ: typ, data: b}:
	default:
		c.closeLocked(websocket.StatusCode(v1.GatewayCloseCode_GATEWAY_CLOSE_CODE_RATE_LIMITED), "send queue overflow", false)
	}
}

func (c *conn) sendFrame(f *v1.GatewayFrame) {
	typ, b, err := c.codec.encode(frame(f))
	if err == nil {
		c.send(typ, b)
	}
}

// closeGraceful closes after already queued messages are written.
func (c *conn) closeGraceful(code websocket.StatusCode, why string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed, c.serverClosed = true, true
	closeMetric(code)
	select {
	case c.out <- outMsg{close: code, why: why}:
	default:
		go func() { _ = c.ws.Close(code, why) }()
	}
}

// closeNow closes immediately (queued messages may be dropped).
func (c *conn) closeNow(code websocket.StatusCode, why string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closeLocked(code, why, true)
}

func (c *conn) closeLocked(code websocket.StatusCode, why string, server bool) {
	if c.closed {
		return
	}
	c.closed = true
	c.serverClosed = c.serverClosed || server || code != 0
	closeMetric(code)
	go func() {
		_ = c.ws.Close(code, why)
		c.cancel()
	}()
}

func (c *conn) isServerClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.serverClosed
}

// finish releases the socket when the read side is done. A server-initiated close lets the
// writer deliver the close frame; otherwise (peer gone) everything is torn down now.
func (c *conn) finish() {
	c.mu.Lock()
	closed := c.closed
	c.closed = true
	c.mu.Unlock()
	if !closed {
		_ = c.ws.CloseNow()
		c.cancel()
	}
}
