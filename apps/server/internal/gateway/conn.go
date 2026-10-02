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
	// Inbound frames per socket (review M3/R7). Soft budget: extra SUBSCRIBE / TYPING /
	// PRESENCE frames beyond it are dropped (fast room switching must not disconnect).
	// Hard budget: sustained flooding closes the socket with 4008.
	inboundBurst = 10
	inboundRate  = 2.0 // frames per second
	floodBurst   = 100
	floodRate    = 50.0
)

type outMsg struct {
	typ     websocket.MessageType
	data    []byte
	close   websocket.StatusCode // non-zero: close the socket after previous messages
	why     string
	session *Session
	event   *encEvent
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
	held         bool     // writer does not take from out until the replay is set
	wake         chan struct{}

	tokens float64 // soft inbound bucket
	flood  float64 // hard inbound bucket
	last   time.Time
}

func newConn(ws *websocket.Conn, c codec) *conn {
	ctx, cancel := context.WithCancel(context.Background())
	return &conn{ws: ws, codec: c, out: make(chan outMsg, sendQueue), ctx: ctx, cancel: cancel,
		wake: make(chan struct{}, 1), tokens: inboundBurst, flood: floodBurst, last: time.Now()}
}

// inbound meters one inbound frame (read loop only, no locking needed): ok=false means the
// frame should be ignored (soft budget exhausted), flood=true that the socket must close.
func (c *conn) inbound() (ok, flood bool) {
	now := time.Now()
	dt := now.Sub(c.last).Seconds()
	c.last = now
	c.tokens = min(inboundBurst, c.tokens+dt*inboundRate)
	c.flood = min(floodBurst, c.flood+dt*floodRate)
	if c.flood < 1 {
		return false, true
	}
	c.flood--
	if c.tokens < 1 {
		return false, false
	}
	c.tokens--
	return true, false
}

// writeLoop writes queued messages. Replay frames always go out before any message taken
// from the queue. While held (RESUME is reading the replay from Redis), messages taken from
// the queue are stashed — held is re-checked after every receive, because the writer may
// already be blocked on the queue when hold() is called — and written after the replay.
func (c *conn) writeLoop() {
	defer c.cancel()
	var stash []outMsg
	for {
		c.mu.Lock()
		replay, held := c.replay, c.held
		c.replay = nil
		c.mu.Unlock()
		for _, m := range replay {
			if !c.write(m) {
				return
			}
		}
		if !held {
			for _, m := range stash {
				if !c.write(m) {
					return
				}
			}
			stash = nil
		}
		select {
		case <-c.ctx.Done():
			return
		case <-c.wake:
		case m := <-c.out:
			c.mu.Lock()
			held := c.held
			c.mu.Unlock()
			if held {
				// The stash counts against the same budget as the queue (review B3): a
				// client that cannot keep up during a long hold is closed like on overflow.
				if len(stash)+len(c.out) >= sendQueue {
					c.mu.Lock()
					c.closeLocked(websocket.StatusCode(v1.GatewayCloseCode_GATEWAY_CLOSE_CODE_RATE_LIMITED), "send queue overflow", false)
					c.mu.Unlock()
					return
				}
				stash = append(stash, m)
				continue
			}
			c.mu.Lock()
			replay := c.replay // set before this message was queued (takeover path)
			c.replay = nil
			c.mu.Unlock()
			for _, r := range replay {
				if !c.write(r) {
					return
				}
			}
			for _, st := range stash {
				if !c.write(st) {
					return
				}
			}
			stash = nil
			if !c.write(m) {
				return
			}
		}
	}
}

// hold stops the writer from taking queued messages until setReplay.
func (c *conn) hold() {
	c.mu.Lock()
	c.held = true
	c.mu.Unlock()
}

// setReplay queues frames that must precede everything queued, and releases a hold.
func (c *conn) setReplay(ms []outMsg) {
	c.mu.Lock()
	c.replay = append(c.replay, ms...)
	c.held = false
	c.mu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *conn) write(m outMsg) bool {
	if m.session != nil && m.session.identityEnabled() && !m.session.allowsEvent(m.event) {
		_ = c.ws.Close(4000, "identity resync required")
		return false
	}
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
func (c *conn) send(typ websocket.MessageType, b []byte) { c.sendEvent(typ, b, nil, nil) }

func (c *conn) sendEvent(typ websocket.MessageType, b []byte, session *Session, event *encEvent) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	select {
	case c.out <- outMsg{typ: typ, data: b, session: session, event: event}:
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
	c.closed, c.serverClosed, c.held = true, true, false
	closeMetric(code)
	select {
	case c.out <- outMsg{close: code, why: why}:
		select {
		case c.wake <- struct{}{}:
		default:
		}
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
