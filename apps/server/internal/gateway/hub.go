// Package gateway is the realtime WebSocket gateway (docs/05, ADR-0007): HELLO / IDENTIFY /
// RESUME / HEARTBEAT, per-session seq with a Redis resume buffer, presence, typing and
// fan-out of REST events from Redis pub/sub with per-recipient VIEW_ROOM filtering.
package gateway

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/voice"
)

// Config tunes the gateway.
type Config struct {
	HeartbeatInterval  time.Duration // docs/05: ~41 s
	MaxSessionsPerUser int           // docs/05: 5
	ShutdownSpread     time.Duration // RECONNECT spread on graceful shutdown
	AllowedOrigins     []string      // web client origins (PUBLIC_APP_URL[_ALT]), see OriginAllowed
}

// Hub owns this instance's gateway sessions.
type Hub struct {
	cfg      Config
	instance string
	db       *db.DB
	redis    rueidis.Client
	auth     *auth.Service
	pub      events.Publisher
	voice    voice.Store
	pres     presenceStore
	buf      bufferStore

	mu       sync.RWMutex
	sessions map[uuid.UUID]*Session
	byUser   map[uuid.UUID]map[*Session]bool
	byWS     map[uuid.UUID]map[*Session]bool
	states   map[uuid.UUID]*wsState
	releases map[uuid.UUID]chan struct{}

	closing  atomic.Bool
	nSockets atomic.Int64
}

// New creates a hub. Run must be started for fan-out.
func New(cfg Config, d *db.DB, r rueidis.Client, a *auth.Service, pub events.Publisher) *Hub {
	if cfg.HeartbeatInterval == 0 {
		cfg.HeartbeatInterval = 41 * time.Second
	}
	if cfg.MaxSessionsPerUser == 0 {
		cfg.MaxSessionsPerUser = 5
	}
	return &Hub{
		cfg: cfg, instance: uuid.NewString(), db: d, redis: r, auth: a, pub: pub,
		voice: voice.Store{C: r}, pres: presenceStore{c: r, ttl: 2 * cfg.HeartbeatInterval}, buf: bufferStore{c: r},
		sessions: map[uuid.UUID]*Session{}, byUser: map[uuid.UUID]map[*Session]bool{},
		byWS: map[uuid.UUID]map[*Session]bool{}, states: map[uuid.UUID]*wsState{}, releases: map[uuid.UUID]chan struct{}{},
	}
}

func (h *Hub) sockets(d int64) { socketsGauge.Set(float64(h.nSockets.Add(d))) }

func ctlChannel(instance string) string { return "gw:ctl:" + instance }
func instKey(instance string) string    { return "gw:inst:" + instance }

// Run subscribes to events and runs background loops until ctx is done.
func (h *Hub) Run(ctx context.Context) {
	go h.lease(ctx) //nolint:gosec // G118: final DEL after ctx is done uses its own context on purpose
	go h.sweepPresence(ctx)
	first := true
	for ctx.Err() == nil {
		cmd := h.redis.B().Psubscribe().Pattern(events.WorkspacePrefix+"*", events.UserPrefix+"*",
			events.RevokedPrefix+"*", ctlChannel(h.instance)).Build()
		if !first {
			// Events published while we were not subscribed are lost: make clients resync.
			h.invalidateAll()
		}
		first = false
		err := h.redis.Receive(ctx, cmd, h.onMessage)
		if ctx.Err() != nil {
			return
		}
		slog.Error("gateway pubsub disconnected", "err", err)
		time.Sleep(time.Second)
	}
}

func (h *Hub) lease(ctx context.Context) {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		_ = h.redis.Do(ctx, h.redis.B().Set().Key(instKey(h.instance)).Value("1").Ex(30*time.Second).Build()).Error()
		select {
		case <-ctx.Done():
			_ = h.redis.Do(context.Background(), h.redis.B().Del().Key(instKey(h.instance)).Build()).Error()
			return
		case <-t.C:
		}
	}
}

func (h *Hub) onMessage(m rueidis.PubSubMessage) {
	start := time.Now()
	ch := m.Channel
	switch {
	case strings.HasPrefix(ch, "gw:ctl:"):
		h.onControl(m.Message)
		return
	case strings.HasPrefix(ch, events.RevokedPrefix):
		if sid, err := uuid.Parse(strings.TrimPrefix(ch, events.RevokedPrefix)); err == nil {
			for _, s := range h.sessionsWhere(func(s *Session) bool { return s.asess == sid }) {
				h.destroy(s, 4010, "session revoked")
			}
		}
		return
	}
	id, ev, err := events.Decode([]byte(m.Message))
	if err != nil {
		slog.Warn("gateway: bad event payload", "channel", ch, "err", err)
		return
	}
	eventsReceived.Inc()
	switch {
	case strings.HasPrefix(ch, events.WorkspacePrefix):
		if wid, err := uuid.Parse(strings.TrimPrefix(ch, events.WorkspacePrefix)); err == nil {
			h.routeWorkspace(wid, id, ev)
		}
	case strings.HasPrefix(ch, events.UserPrefix):
		if uid, err := uuid.Parse(strings.TrimPrefix(ch, events.UserPrefix)); err == nil {
			h.routeUser(uid, id, ev)
		}
	}
	fanoutSeconds.Observe(time.Since(start).Seconds())
}

func (h *Hub) sessionsWhere(pred func(*Session) bool) []*Session {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var out []*Session
	for _, s := range h.sessions {
		if pred(s) {
			out = append(out, s)
		}
	}
	return out
}

func (h *Hub) inWorkspace(wid uuid.UUID) []*Session {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]*Session, 0, len(h.byWS[wid]))
	for s := range h.byWS[wid] {
		out = append(out, s)
	}
	return out
}

func (h *Hub) ofUser(uid uuid.UUID) []*Session {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]*Session, 0, len(h.byUser[uid]))
	for s := range h.byUser[uid] {
		out = append(out, s)
	}
	return out
}

// ---- workspace state ----

// ensureState makes sure the workspace state is loaded (or loading). Events that arrive
// while loading are kept in a backlog and routed right after the load.
func (h *Hub) ensureState(ctx context.Context, wid uuid.UUID) {
	h.mu.Lock()
	st := h.states[wid]
	if st != nil {
		h.mu.Unlock()
		return
	}
	st = &wsState{loading: true}
	h.states[wid] = st
	h.mu.Unlock()

	loaded, err := loadState(ctx, h.db.Q, wid)
	st.mu.Lock()
	defer st.mu.Unlock()
	if err != nil {
		slog.Error("gateway: load workspace state", "workspace", wid, "err", err)
		loaded = &wsState{rooms: map[uuid.UUID]*v1.Room{}, roles: map[uuid.UUID]perm.Role{}}
	}
	st.ws, st.rooms, st.roles = loaded.ws, loaded.rooms, loaded.roles
	for len(st.backlog) > 0 {
		p := st.backlog[0]
		st.backlog = st.backlog[1:]
		h.routeLocked(st, wid, p.id, p.ev)
	}
	st.loading = false
}

func (h *Hub) state(wid uuid.UUID) *wsState {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.states[wid]
}

// ---- routing ----

func (h *Hub) routeWorkspace(wid, id uuid.UUID, ev *v1.DispatchEvent) {
	st := h.state(wid)
	if st == nil {
		return // no local session in this workspace
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.loading {
		st.backlog = append(st.backlog, pendingEvent{id: id, ev: ev})
		return
	}
	h.routeLocked(st, wid, id, ev)
}

func parseID(s string) uuid.UUID {
	id, _ := uuid.Parse(s)
	return id
}

// routeLocked applies ev to the workspace state and delivers it to each local session as
// that recipient should see it. st.mu is held (write).
func (h *Hub) routeLocked(st *wsState, wid, id uuid.UUID, ev *v1.DispatchEvent) {
	sessions := h.inWorkspace(wid)
	view := func(rid, uid uuid.UUID) bool { return st.bits(rid, uid).Has(perm.ViewRoom) }
	roomChange := func(rid uuid.UUID, apply func(), changed func(room *v1.Room) *v1.DispatchEvent) {
		before := make(map[*Session]bool, len(sessions))
		for _, s := range sessions {
			before[s] = view(rid, s.user)
		}
		apply()
		room := st.rooms[rid]
		for _, s := range sessions {
			after := room != nil && view(rid, s.user)
			if out := transition(before[s], after, changed(room), room, wid, rid); out != nil {
				s.dispatch(id, out)
			}
		}
	}
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_RoomCreate, *v1.DispatchEvent_RoomUpdate:
		_ = e
		var r *v1.Room
		if rc := ev.GetRoomCreate(); rc != nil {
			r = rc.GetRoom()
		} else {
			r = ev.GetRoomUpdate().GetRoom()
		}
		rid := parseID(r.GetId())
		roomChange(rid, func() { st.rooms[rid] = r }, func(*v1.Room) *v1.DispatchEvent { return ev })
	case *v1.DispatchEvent_RoomPermissionsUpdate:
		rid := parseID(e.RoomPermissionsUpdate.GetRoomId())
		if st.rooms[rid] == nil {
			return
		}
		roomChange(rid, func() { st.rooms[rid] = withPermissions(st.rooms[rid], e.RoomPermissionsUpdate.GetPermissions()) },
			func(*v1.Room) *v1.DispatchEvent { return ev })
	case *v1.DispatchEvent_RoomDelete:
		rid := parseID(e.RoomDelete.GetRoomId())
		for _, s := range sessions {
			if view(rid, s.user) {
				s.dispatch(id, ev)
			}
		}
		delete(st.rooms, rid)
	case *v1.DispatchEvent_MessageCreate, *v1.DispatchEvent_MessageUpdate:
		var m *v1.Message
		if mc := ev.GetMessageCreate(); mc != nil {
			m = mc.GetMessage()
		} else {
			m = ev.GetMessageUpdate().GetMessage()
		}
		h.toViewers(sessions, view, parseID(m.GetRoomId()), id, ev)
	case *v1.DispatchEvent_MessageDelete:
		h.toViewers(sessions, view, parseID(e.MessageDelete.GetRoomId()), id, ev)
	case *v1.DispatchEvent_MessageReactionAdd:
		h.toViewers(sessions, view, parseID(e.MessageReactionAdd.GetRoomId()), id, ev)
	case *v1.DispatchEvent_MessageReactionRemove:
		h.toViewers(sessions, view, parseID(e.MessageReactionRemove.GetRoomId()), id, ev)
	case *v1.DispatchEvent_VoiceStreamStart:
		h.toViewers(sessions, view, parseID(e.VoiceStreamStart.GetRoomId()), id, ev)
	case *v1.DispatchEvent_VoiceStreamStop:
		h.toViewers(sessions, view, parseID(e.VoiceStreamStop.GetRoomId()), id, ev)
	case *v1.DispatchEvent_TypingStart:
		rid, typer := parseID(e.TypingStart.GetRoomId()), parseID(e.TypingStart.GetUserId())
		for _, s := range sessions {
			if s.user != typer && view(rid, s.user) && s.isSubscribed(rid) {
				s.dispatch(id, ev)
			}
		}
	case *v1.DispatchEvent_VoiceStateUpdate:
		for _, s := range sessions {
			uid := s.user
			vs := sanitizeVoice(e.VoiceStateUpdate.GetState(), func(rid uuid.UUID) bool { return view(rid, uid) })
			if vs == e.VoiceStateUpdate.GetState() {
				s.dispatch(id, ev)
			} else {
				s.dispatch(id, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceStateUpdate{VoiceStateUpdate: &v1.VoiceStateUpdate{State: vs}}})
			}
		}
	case *v1.DispatchEvent_WorkspaceMemberAdd:
		m := e.WorkspaceMemberAdd.GetMember()
		if r, ok := perm.RoleFromProto(m.GetRole()); ok {
			st.roles[parseID(m.GetUser().GetId())] = r
		}
		h.toAll(sessions, id, ev)
	case *v1.DispatchEvent_WorkspaceMemberUpdate:
		m := e.WorkspaceMemberUpdate.GetMember()
		uid := parseID(m.GetUser().GetId())
		before := map[uuid.UUID]bool{}
		for rid := range st.rooms {
			before[rid] = view(rid, uid)
		}
		if r, ok := perm.RoleFromProto(m.GetRole()); ok {
			st.roles[uid] = r
		}
		h.toAll(sessions, id, ev)
		// The member's own sessions see rooms appear / disappear with the role change.
		for _, s := range sessions {
			if s.user != uid {
				continue
			}
			for rid, room := range st.rooms {
				if out := transition(before[rid], view(rid, uid), nil, room, wid, rid); out != nil {
					s.dispatch(uuid.New(), out)
				}
			}
		}
	case *v1.DispatchEvent_WorkspaceMemberRemove:
		uid := parseID(e.WorkspaceMemberRemove.GetUserId())
		delete(st.roles, uid)
		for _, s := range sessions {
			if s.user != uid {
				s.dispatch(id, ev)
			}
		}
	case *v1.DispatchEvent_WorkspaceUpdate:
		st.ws = e.WorkspaceUpdate.GetWorkspace()
		h.toAll(sessions, id, ev)
	case *v1.DispatchEvent_WorkspaceDelete:
		h.toAll(sessions, id, ev)
		for _, s := range sessions {
			h.leaveWorkspace(s, wid)
		}
	default: // presence, other workspace-wide events
		h.toAll(sessions, id, ev)
	}
}

func (h *Hub) toAll(sessions []*Session, id uuid.UUID, ev *v1.DispatchEvent) {
	for _, s := range sessions {
		s.dispatch(id, ev)
	}
}

func (h *Hub) toViewers(sessions []*Session, view func(rid, uid uuid.UUID) bool, rid, id uuid.UUID, ev *v1.DispatchEvent) {
	for _, s := range sessions {
		if view(rid, s.user) {
			s.dispatch(id, ev)
		}
	}
}

func (h *Hub) routeUser(uid, id uuid.UUID, ev *v1.DispatchEvent) {
	sessions := h.ofUser(uid)
	if len(sessions) == 0 {
		return
	}
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_WorkspaceCreate:
		snap := e.WorkspaceCreate.GetSnapshot()
		wid := parseID(snap.GetWorkspace().GetId())
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		h.fillLive(ctx, wid, snap)
		for _, s := range sessions {
			h.joinWorkspace(s, wid)
		}
		h.ensureState(ctx, wid)
	case *v1.DispatchEvent_WorkspaceDelete:
		wid := parseID(e.WorkspaceDelete.GetWorkspaceId())
		defer func() {
			for _, s := range sessions {
				h.leaveWorkspace(s, wid)
			}
		}()
	}
	for _, s := range sessions {
		s.dispatch(id, ev)
	}
}

// fillLive adds Redis-backed parts (voice states, presences) to a snapshot.
func (h *Hub) fillLive(ctx context.Context, wid uuid.UUID, snap *v1.WorkspaceSnapshot) {
	visible := map[uuid.UUID]bool{}
	for _, r := range snap.GetRooms() {
		visible[parseID(r.GetId())] = true
	}
	var voiceRooms []uuid.UUID
	for _, r := range snap.GetRooms() {
		if r.GetType() == v1.RoomType_ROOM_TYPE_VOICE {
			voiceRooms = append(voiceRooms, parseID(r.GetId()))
		}
	}
	if started, err := h.voice.StartedAt(ctx, voiceRooms); err == nil {
		for _, r := range snap.GetRooms() {
			if t, ok := started[parseID(r.GetId())]; ok {
				r.VoiceStartedAt = timestamppb.New(t)
			}
		}
	}
	if states, err := h.voice.List(ctx, wid); err == nil {
		snap.VoiceStates = nil
		for _, vs := range voice.AggregateAll(wid, states) {
			snap.VoiceStates = append(snap.VoiceStates, sanitizeVoice(vs, func(rid uuid.UUID) bool { return visible[rid] }))
		}
	}
	users := make([]uuid.UUID, 0, len(snap.GetMembers()))
	for _, m := range snap.GetMembers() {
		users = append(users, parseID(m.GetUser().GetId()))
	}
	if pres, err := h.pres.get(ctx, users); err == nil {
		snap.Presences = nil
		for _, u := range users {
			snap.Presences = append(snap.Presences, pres[u])
		}
	}
}

// ---- session registry ----

func (h *Hub) register(s *Session, workspaces []uuid.UUID) {
	h.mu.Lock()
	h.sessions[s.id] = s
	if h.byUser[s.user] == nil {
		h.byUser[s.user] = map[*Session]bool{}
	}
	h.byUser[s.user][s] = true
	h.mu.Unlock()
	for _, wid := range workspaces {
		h.joinWorkspace(s, wid)
	}
	sessionsGauge.Set(float64(h.count()))
}

func (h *Hub) count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.sessions)
}

func (h *Hub) joinWorkspace(s *Session, wid uuid.UUID) {
	h.mu.Lock()
	if h.byWS[wid] == nil {
		h.byWS[wid] = map[*Session]bool{}
	}
	h.byWS[wid][s] = true
	h.mu.Unlock()
	s.mu.Lock()
	s.workspaces[wid] = true
	s.mu.Unlock()
}

func (h *Hub) leaveWorkspace(s *Session, wid uuid.UUID) {
	h.mu.Lock()
	delete(h.byWS[wid], s)
	if len(h.byWS[wid]) == 0 {
		delete(h.byWS, wid)
		delete(h.states, wid)
	}
	h.mu.Unlock()
	s.mu.Lock()
	delete(s.workspaces, wid)
	s.mu.Unlock()
}

// unregister removes the session from this instance (Redis state is left to the caller).
func (h *Hub) unregister(s *Session) {
	s.mu.Lock()
	wss := make([]uuid.UUID, 0, len(s.workspaces))
	for w := range s.workspaces {
		wss = append(wss, w)
	}
	s.mu.Unlock()
	for _, w := range wss {
		h.leaveWorkspace(s, w)
	}
	h.mu.Lock()
	if h.sessions[s.id] == s {
		delete(h.sessions, s.id)
	}
	delete(h.byUser[s.user], s)
	if len(h.byUser[s.user]) == 0 {
		delete(h.byUser, s.user)
	}
	h.mu.Unlock()
	sessionsGauge.Set(float64(h.count()))
}

// destroy ends a session for good (not resumable). code 0 = no socket close frame.
func (h *Hub) destroy(s *Session, code int, why string) {
	s.mu.Lock()
	if s.dead {
		s.mu.Unlock()
		return
	}
	s.dead = true
	c := s.conn
	s.conn = nil
	if s.detachT != nil {
		s.detachT.Stop()
	}
	s.mu.Unlock()
	if c != nil {
		h.sockets(-1)
		if code != 0 {
			c.closeGraceful(statusCode(code), why)
		} else {
			c.closeNow(4000, why)
		}
	}
	h.unregister(s)
	close(s.wq)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h.buf.drop(ctx, s.id)
	h.forgetDevice(ctx, s)
	_ = h.pres.remove(ctx, s.user, s.id)
	h.publishPresence(ctx, s.user)
}

// invalidateAll forces every client to IDENTIFY again (used after a pub/sub gap).
func (h *Hub) invalidateAll() {
	for _, s := range h.sessionsWhere(func(*Session) bool { return true }) {
		s.mu.Lock()
		c := s.conn
		s.mu.Unlock()
		if c != nil {
			c.sendFrame(&v1.GatewayFrame{Payload: &v1.GatewayFrame_InvalidSession{InvalidSession: &v1.InvalidSession{Resumable: false}}})
		}
		h.destroy(s, 4000, "resync required")
	}
}

// ---- presence ----

func (h *Hub) publishPresence(ctx context.Context, user uuid.UUID) {
	h.announcePresence(ctx, user, false)
}

// StatusChanged announces a custom status change (PATCH /api/me/status) even if the
// online status did not change.
func (h *Hub) StatusChanged(ctx context.Context, user uuid.UUID) {
	h.announcePresence(context.WithoutCancel(ctx), user, true)
}

func (h *Hub) announcePresence(ctx context.Context, user uuid.UUID, force bool) {
	ps, err := h.pres.get(ctx, []uuid.UUID{user})
	if err != nil {
		return
	}
	p := ps[user]
	changed, err := h.pres.changed(ctx, p)
	if err != nil || (!changed && !force) {
		return
	}
	if u, err := h.db.Q.GetUser(ctx, user); err == nil {
		p.StatusText, p.StatusEmoji, p.StatusExpiresAt = pbconv.Status(u)
	}
	wids, err := h.db.Q.ListUserWorkspaceIDs(ctx, user)
	if err != nil || len(wids) == 0 {
		return
	}
	h.pub.Workspaces(ctx, wids, &v1.DispatchEvent{Event: &v1.DispatchEvent_PresenceUpdate{PresenceUpdate: &v1.PresenceUpdate{Presence: p}}})
}

// sweepPresence publishes OFFLINE for users whose sessions expired without a clean close
// (crash, network loss). One instance per period does it.
func (h *Hub) sweepPresence(ctx context.Context) {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		lock := h.redis.B().Set().Key("gw:presence:sweep").Value(h.instance).Nx().Ex(14 * time.Second).Build()
		if h.redis.Do(ctx, lock).Error() != nil {
			continue
		}
		users, err := h.pres.stale(ctx)
		if err != nil {
			continue
		}
		for _, u := range users {
			h.publishPresence(ctx, u)
		}
	}
}

// ---- control messages between instances ----

func (h *Hub) sendControl(ctx context.Context, instance, msg string) {
	_ = h.redis.Do(ctx, h.redis.B().Publish().Channel(ctlChannel(instance)).Message(msg).Build()).Error()
}

func (h *Hub) onControl(msg string) {
	f := strings.Fields(msg)
	if len(f) < 2 {
		return
	}
	gsid := parseID(f[1])
	switch f[0] {
	case "release": // another instance resumes this session: stop owning it
		h.mu.RLock()
		s := h.sessions[gsid]
		h.mu.RUnlock()
		go func() {
			if s != nil {
				h.release(s, "resumed elsewhere")
			}
			if len(f) > 2 {
				h.sendControl(context.Background(), f[2], "released "+gsid.String())
			}
		}()
	case "released":
		h.mu.Lock()
		ch := h.releases[gsid]
		delete(h.releases, gsid)
		h.mu.Unlock()
		if ch != nil {
			close(ch)
		}
	case "kill":
		h.mu.RLock()
		s := h.sessions[gsid]
		h.mu.RUnlock()
		if s != nil {
			go h.destroy(s, 4000, "replaced by a new session")
		}
	}
}

// release hands a session over to another instance: stop dispatching, flush the buffer,
// forget it locally without touching Redis state.
func (h *Hub) release(s *Session, why string) {
	s.mu.Lock()
	if s.dead {
		s.mu.Unlock()
		return
	}
	s.dead = true
	c := s.conn
	s.conn = nil
	if s.detachT != nil {
		s.detachT.Stop()
	}
	s.mu.Unlock()
	if c != nil {
		h.sockets(-1)
		c.closeNow(4000, why)
	}
	h.unregister(s)
	s.flush()
	close(s.wq)
}

// Shutdown asks every client to reconnect (spread over cfg.ShutdownSpread to avoid a
// thundering herd) and hands sessions off so that any instance can resume them.
func (h *Hub) Shutdown(ctx context.Context) {
	h.closing.Store(true)
	all := h.sessionsWhere(func(*Session) bool { return true })
	var wg sync.WaitGroup
	for _, s := range all {
		wg.Add(1)
		delay := time.Duration(0)
		if h.cfg.ShutdownSpread > 0 {
			delay = time.Duration(rand.Int64N(int64(h.cfg.ShutdownSpread))) //nolint:gosec // jitter
		}
		go func() {
			defer wg.Done()
			select {
			case <-time.After(delay):
			case <-ctx.Done():
			}
			s.mu.Lock()
			c := s.conn
			s.mu.Unlock()
			if c != nil {
				c.sendFrame(&v1.GatewayFrame{Payload: &v1.GatewayFrame_Reconnect{Reconnect: &v1.Reconnect{}}})
			}
			h.release(s, "server restart")
			_ = h.buf.setOwner(context.WithoutCancel(ctx), s.id, "")
		}()
	}
	wg.Wait()
}
