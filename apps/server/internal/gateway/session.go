package gateway

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// bufferQueue: frames waiting for the Redis buffer writer. Overflow (Redis far behind)
// marks the session unresumable instead of growing memory (security review M4).
const bufferQueue = 512

// encEvent is a DispatchEvent marshalled at most once per instance, however many sessions
// receive it (security review M13); each session only prepends its op and seq.
type encEvent struct {
	ev   *v1.DispatchEvent
	once sync.Once
	b    []byte
	err  error
}

func newEnc(ev *v1.DispatchEvent) *encEvent { return &encEvent{ev: ev} }

func (e *encEvent) bytes() ([]byte, error) {
	e.once.Do(func() { e.b, e.err = proto.Marshal(e.ev) })
	return e.b, e.err
}

// frameBytes builds a binary GatewayFrame{op: DISPATCH, seq, dispatch: payload} directly
// from the encoded payload (field numbers from gateway.proto: op=1, seq=2, dispatch=24).
func frameBytes(seq uint64, payload []byte) []byte {
	b := make([]byte, 0, len(payload)+16)
	b = protowire.AppendTag(b, 1, protowire.VarintType)
	b = protowire.AppendVarint(b, uint64(v1.GatewayOpcode_GATEWAY_OPCODE_DISPATCH))
	b = protowire.AppendTag(b, 2, protowire.VarintType)
	b = protowire.AppendVarint(b, seq)
	b = protowire.AppendTag(b, 24, protowire.BytesType)
	return protowire.AppendBytes(b, payload)
}

type pendingEvent struct {
	id  uuid.UUID
	enc *encEvent
}

// Session is a gateway session (one device connection that survives reconnects via RESUME).
// It lives on its owning instance; while detached (no socket) it keeps buffering events for
// up to resumeWindow.
type Session struct {
	id, user, asess uuid.UUID
	hub             *Hub

	mu         sync.Mutex
	seq        uint64
	ready      bool           // READY (or resume replay) sent; before that events wait in pending
	paused     int            // >0: events wait in pending (async WORKSPACE_CREATE preparation)
	pending    []pendingEvent //
	conn       *conn
	dead       bool
	workspaces map[uuid.UUID]bool
	subscribed map[uuid.UUID]bool
	status     v1.PresenceStatus
	recent     [128]uuid.UUID
	recentN    int
	detachT    *time.Timer

	wq     chan entry
	broken atomic.Bool // buffer overflow / Redis error: no longer resumable
	closed atomic.Bool // wq closed
}

func newSession(h *Hub, id, user, asess uuid.UUID) *Session {
	s := &Session{
		id: id, user: user, asess: asess, hub: h,
		workspaces: map[uuid.UUID]bool{}, subscribed: map[uuid.UUID]bool{},
		status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
		wq:     make(chan entry, bufferQueue),
	}
	go s.bufferWriter()
	return s
}

// closeQueue stops the buffer writer (idempotent).
func (s *Session) closeQueue() {
	if s.closed.CompareAndSwap(false, true) {
		close(s.wq)
	}
}

// bufferWriter appends dispatched frames to the Redis session buffer in order.
// An entry with a nil frame and a flush channel acts as a barrier.
func (s *Session) bufferWriter() {
	batch := make([]entry, 0, 64)
	for e := range s.wq {
		batch = batch[:0]
		var barriers []chan struct{}
		collect := func(e entry) {
			if e.flush != nil {
				barriers = append(barriers, e.flush)
				return
			}
			batch = append(batch, e)
		}
		collect(e)
	drain:
		for len(batch) < 64 {
			select {
			case e, ok := <-s.wq:
				if !ok {
					break drain
				}
				collect(e)
			default:
				break drain
			}
		}
		if len(batch) > 0 {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := s.hub.buf.append(ctx, s.id, batch); err != nil {
				slog.Warn("gateway buffer append", "session", s.id, "err", err)
				s.broken.Store(true)
			}
			cancel()
		}
		for _, b := range barriers {
			close(b)
		}
	}
}

// flush waits until everything dispatched so far is in Redis (must not hold s.mu).
func (s *Session) flush() {
	done := make(chan struct{})
	select {
	case s.wq <- entry{flush: done}:
		select {
		case <-done:
		case <-time.After(6 * time.Second):
			s.broken.Store(true)
		}
	default:
		s.broken.Store(true)
	}
}

func (s *Session) seen(id uuid.UUID) bool {
	for _, r := range s.recent {
		if r == id {
			return true
		}
	}
	s.recent[s.recentN%len(s.recent)] = id
	s.recentN++
	return false
}

// dispatch delivers an event built for this recipient only.
func (s *Session) dispatch(id uuid.UUID, ev *v1.DispatchEvent) { s.dispatchEnc(id, newEnc(ev)) }

// dispatchEnc delivers a (shared) encoded event, deduplicated by event id.
func (s *Session) dispatchEnc(id uuid.UUID, enc *encEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead || s.seen(id) {
		return
	}
	if !s.ready || s.paused > 0 {
		s.pending = append(s.pending, pendingEvent{id: id, enc: enc})
		return
	}
	s.emit(id, enc)
}

// emit assigns the next seq, buffers the frame and sends it; s.mu must be held.
func (s *Session) emit(id uuid.UUID, enc *encEvent) {
	payload, err := enc.bytes()
	if err != nil {
		return
	}
	s.seq++
	bin := frameBytes(s.seq, payload)
	if !s.closed.Load() {
		select {
		case s.wq <- entry{id: id, seq: s.seq, frame: bin}:
		default:
			s.broken.Store(true)
		}
	}
	eventsDispatched.Inc()
	if s.conn != nil {
		typ, b, err := s.conn.codec.transcode(bin)
		if err == nil {
			s.conn.send(typ, b)
		}
	}
}

// flushPending emits queued events once nothing holds them back; s.mu must be held.
func (s *Session) flushPending(skip map[uuid.UUID]bool) {
	if !s.ready || s.paused > 0 {
		return
	}
	for _, p := range s.pending {
		if !skip[p.id] {
			s.emit(p.id, p.enc)
		}
	}
	s.pending = nil
}

// pause makes later events wait (in order) until resume; returns the marker at which the
// prepared event will be inserted.
func (s *Session) pause() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.paused++
	return len(s.pending)
}

// resume inserts the prepared event where the pause began and releases the queue.
func (s *Session) resume(marker int, id uuid.UUID, enc *encEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead {
		return
	}
	marker = min(marker, len(s.pending))
	p := append([]pendingEvent{}, s.pending[:marker]...)
	p = append(p, pendingEvent{id: id, enc: enc})
	s.pending = append(p, s.pending[marker:]...)
	s.paused--
	s.flushPending(nil)
}

// detach drops the socket but keeps the session resumable for resumeWindow.
func (s *Session) detach(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead || s.conn != c {
		return
	}
	s.conn = nil
	s.hub.sockets(-1)
	if s.detachT != nil {
		s.detachT.Stop()
	}
	s.detachT = time.AfterFunc(resumeWindow, func() { s.hub.destroy(s, 0, "") })
}

// attachLocked binds a socket (s.mu held). Frames for it are queued right away; the caller
// decides what precedes them (setReplay) — or holds the socket first (conn.hold).
func (s *Session) attachLocked(c *conn) {
	if s.detachT != nil {
		s.detachT.Stop()
		s.detachT = nil
	}
	if old := s.conn; old != nil && old != c {
		old.closeNow(4000, "resumed elsewhere")
		s.hub.sockets(-1)
	}
	s.conn = c
	s.hub.sockets(1)
}
