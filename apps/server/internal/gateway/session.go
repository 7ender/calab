package gateway

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

type pendingEvent struct {
	id uuid.UUID
	ev *v1.DispatchEvent
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
}

func newSession(h *Hub, id, user, asess uuid.UUID) *Session {
	s := &Session{
		id: id, user: user, asess: asess, hub: h,
		workspaces: map[uuid.UUID]bool{}, subscribed: map[uuid.UUID]bool{},
		status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
		wq:     make(chan entry, 4096),
	}
	go s.bufferWriter()
	return s
}

// bufferWriter appends dispatched frames to the Redis session buffer in order.
// An entry with a nil frame and a flush channel acts as a barrier.
func (s *Session) bufferWriter() {
	ctx := context.Background()
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
			if err := s.hub.buf.append(ctx, s.id, batch); err != nil {
				slog.Warn("gateway buffer append", "session", s.id, "err", err)
				s.broken.Store(true)
			}
		}
		for _, b := range barriers {
			close(b)
		}
	}
}

// flush waits until everything dispatched so far is in Redis.
func (s *Session) flush() {
	done := make(chan struct{})
	select {
	case s.wq <- entry{flush: done}:
		<-done
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

// dispatch delivers an event (dedup by event id). Called from the fan-out goroutine.
func (s *Session) dispatch(id uuid.UUID, ev *v1.DispatchEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead || s.seen(id) {
		return
	}
	if !s.ready {
		s.pending = append(s.pending, pendingEvent{id: id, ev: ev})
		return
	}
	s.emit(id, ev)
}

// emit assigns the next seq, buffers the frame and sends it; s.mu must be held.
func (s *Session) emit(id uuid.UUID, ev *v1.DispatchEvent) {
	s.seq++
	f := frame(&v1.GatewayFrame{Seq: s.seq, Payload: &v1.GatewayFrame_Dispatch{Dispatch: ev}})
	bin, err := proto.Marshal(f)
	if err != nil {
		return
	}
	select {
	case s.wq <- entry{id: id, seq: s.seq, frame: bin}:
	default:
		s.broken.Store(true)
	}
	eventsDispatched.Inc()
	if s.conn != nil {
		typ, b, err := s.conn.codec.transcode(bin)
		if err == nil {
			s.conn.send(typ, b)
		}
	}
}

// flushPending emits queued events after READY / replay; s.mu must be held.
func (s *Session) flushPending(skip map[uuid.UUID]bool) {
	for _, p := range s.pending {
		if !skip[p.id] {
			s.emit(p.id, p.ev)
		}
	}
	s.pending = nil
	s.ready = true
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

// attach binds a socket; replay frames are written before any new event.
func (s *Session) attachLocked(c *conn, replay []outMsg) {
	if s.detachT != nil {
		s.detachT.Stop()
		s.detachT = nil
	}
	if old := s.conn; old != nil && old != c {
		old.closeNow(4000, "resumed elsewhere")
		s.hub.sockets(-1)
	}
	c.setReplay(replay)
	s.conn = c
	s.hub.sockets(1)
}
