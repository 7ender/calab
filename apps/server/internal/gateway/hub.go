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
	"github.com/calaba/calaba/server/internal/db/sqlc"
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
				go h.destroy(s, 4010, "session revoked") // Redis/DB work off the fan-out path
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

// ensureState loads the workspace state synchronously (IDENTIFY / RESUME paths).
func (h *Hub) ensureState(ctx context.Context, wid uuid.UUID) {
	if st, created := h.placeholder(wid); created {
		h.loadInto(ctx, st, wid)
	}
}

// startState makes sure the state is loading without blocking the caller (fan-out path):
// events arriving meanwhile are kept in the backlog and routed after the load.
func (h *Hub) startState(wid uuid.UUID) {
	if st, created := h.placeholder(wid); created {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			h.loadInto(ctx, st, wid)
		}()
	}
}

func (h *Hub) placeholder(wid uuid.UUID) (*wsState, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if st := h.states[wid]; st != nil {
		return st, false
	}
	st := &wsState{loading: true}
	h.states[wid] = st
	return st, true
}

func (h *Hub) loadInto(ctx context.Context, st *wsState, wid uuid.UUID) {
	loaded, err := loadState(ctx, h.db.Q, wid)
	st.mu.Lock()
	defer st.mu.Unlock()
	if err != nil {
		slog.Error("gateway: load workspace state", "workspace", wid, "err", err)
		loaded = &wsState{rooms: map[uuid.UUID]*v1.Room{}, roles: map[uuid.UUID]perm.Role{}}
	}
	st.ws, st.rooms, st.targets, st.roles = loaded.ws, loaded.rooms, loaded.targets, loaded.roles
	for len(st.backlog) > 0 {
		p := st.backlog[0]
		st.backlog = st.backlog[1:]
		h.routeLocked(st, wid, p.id, p.enc.ev)
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
		st.backlog = append(st.backlog, pendingEvent{id: id, enc: newEnc(ev)})
		return
	}
	h.routeLocked(st, wid, id, ev)
}

func parseID(s string) uuid.UUID {
	id, _ := uuid.Parse(s)
	return id
}

// routeLocked applies ev to the workspace state and delivers it to each local session as
// that recipient should see it. st.mu is held (write). The event is encoded once and shared
// by all recipients that get it unchanged.
func (h *Hub) routeLocked(st *wsState, wid, id uuid.UUID, ev *v1.DispatchEvent) {
	sessions := h.inWorkspace(wid)
	shared := newEnc(ev)
	view := func(rid, uid uuid.UUID) bool { return st.bits(rid, uid).Has(perm.ViewRoom) }
	// about(subject): deliver to everyone except guests who share no room with subject.
	about := func(subject uuid.UUID) {
		for _, s := range sessions {
			if !st.hiddenFrom(s.user, subject) {
				s.dispatchEnc(id, shared)
			}
		}
	}
	roomChange := func(rid uuid.UUID, apply func(), changed func() *v1.DispatchEvent) {
		before := make(map[*Session]bool, len(sessions))
		for _, s := range sessions {
			before[s] = view(rid, s.user)
		}
		apply()
		room := st.rooms[rid]
		for _, s := range sessions {
			after := room != nil && view(rid, s.user)
			switch out := transition(before[s], after, changed(), room, wid, rid); out {
			case nil:
			case ev:
				s.dispatchEnc(id, shared)
			default:
				s.dispatch(id, out)
			}
		}
	}
	// Guests see only members they share a room with; events that change rooms, overrides or
	// roles can grow or shrink that set (review R8).
	var guestBefore map[*Session]map[uuid.UUID]bool
	subject := uuid.Nil
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_WorkspaceMemberAdd:
		subject = parseID(e.WorkspaceMemberAdd.GetMember().GetUser().GetId())
	case *v1.DispatchEvent_WorkspaceMemberUpdate:
		subject = parseID(e.WorkspaceMemberUpdate.GetMember().GetUser().GetId())
	case *v1.DispatchEvent_WorkspaceMemberRemove:
		subject = parseID(e.WorkspaceMemberRemove.GetUserId())
	}
	if changesVisibility(st, ev) {
		for _, s := range sessions {
			if st.roles[s.user] == perm.RoleGuest {
				if guestBefore == nil {
					guestBefore = map[*Session]map[uuid.UUID]bool{}
				}
				guestBefore[s] = st.guestVisible(s.user)
			}
		}
		defer h.syncGuestMembers(st, wid, guestBefore, subject)
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
		roomChange(rid, func() { st.setRoom(rid, r) }, func() *v1.DispatchEvent { return ev })
	case *v1.DispatchEvent_RoomPermissionsUpdate:
		rid := parseID(e.RoomPermissionsUpdate.GetRoomId())
		if st.rooms[rid] == nil {
			return
		}
		roomChange(rid, func() { st.setRoom(rid, withPermissions(st.rooms[rid], e.RoomPermissionsUpdate.GetPermissions())) },
			func() *v1.DispatchEvent { return ev })
	case *v1.DispatchEvent_RoomDelete:
		rid := parseID(e.RoomDelete.GetRoomId())
		h.toViewers(sessions, view, rid, id, shared)
		st.delRoom(rid)
	case *v1.DispatchEvent_MessageCreate, *v1.DispatchEvent_MessageUpdate:
		var m *v1.Message
		if mc := ev.GetMessageCreate(); mc != nil {
			m = mc.GetMessage()
		} else {
			m = ev.GetMessageUpdate().GetMessage()
		}
		h.toViewers(sessions, view, parseID(m.GetRoomId()), id, shared)
	case *v1.DispatchEvent_MessageDelete:
		h.toViewers(sessions, view, parseID(e.MessageDelete.GetRoomId()), id, shared)
	case *v1.DispatchEvent_MessageReactionAdd:
		h.toViewers(sessions, view, parseID(e.MessageReactionAdd.GetRoomId()), id, shared)
	case *v1.DispatchEvent_MessageReactionRemove:
		h.toViewers(sessions, view, parseID(e.MessageReactionRemove.GetRoomId()), id, shared)
	case *v1.DispatchEvent_VoiceStreamStart:
		h.toViewers(sessions, view, parseID(e.VoiceStreamStart.GetRoomId()), id, shared)
	case *v1.DispatchEvent_VoiceStreamStop:
		h.toViewers(sessions, view, parseID(e.VoiceStreamStop.GetRoomId()), id, shared)
	case *v1.DispatchEvent_TypingStart:
		rid, typer := parseID(e.TypingStart.GetRoomId()), parseID(e.TypingStart.GetUserId())
		for _, s := range sessions {
			if s.user != typer && view(rid, s.user) && s.isSubscribed(rid) {
				s.dispatchEnc(id, shared)
			}
		}
	case *v1.DispatchEvent_VoiceStateUpdate:
		subject := parseID(e.VoiceStateUpdate.GetState().GetUserId())
		for _, s := range sessions {
			if st.hiddenFrom(s.user, subject) {
				continue
			}
			uid := s.user
			vs := sanitizeVoice(e.VoiceStateUpdate.GetState(), func(rid uuid.UUID) bool { return view(rid, uid) })
			if vs == e.VoiceStateUpdate.GetState() {
				s.dispatchEnc(id, shared)
			} else {
				s.dispatch(id, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceStateUpdate{VoiceStateUpdate: &v1.VoiceStateUpdate{State: vs}}})
			}
		}
	case *v1.DispatchEvent_PresenceUpdate:
		about(parseID(e.PresenceUpdate.GetPresence().GetUserId()))
	case *v1.DispatchEvent_UserUpdate:
		about(parseID(e.UserUpdate.GetUser().GetId()))
	case *v1.DispatchEvent_WorkspaceMemberAdd:
		m := e.WorkspaceMemberAdd.GetMember()
		uid := parseID(m.GetUser().GetId())
		if r, ok := perm.RoleFromProto(m.GetRole()); ok {
			st.setRole(uid, r)
		}
		about(uid)
	case *v1.DispatchEvent_WorkspaceMemberUpdate:
		m := e.WorkspaceMemberUpdate.GetMember()
		uid := parseID(m.GetUser().GetId())
		before := map[uuid.UUID]bool{}
		for rid := range st.rooms {
			before[rid] = view(rid, uid)
		}
		if r, ok := perm.RoleFromProto(m.GetRole()); ok {
			st.setRole(uid, r)
		}
		about(uid)
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
		for _, s := range sessions {
			if s.user != uid && !st.hiddenFrom(s.user, uid) {
				s.dispatchEnc(id, shared)
			}
		}
		st.delRole(uid)
	case *v1.DispatchEvent_WorkspaceUpdate:
		st.ws = e.WorkspaceUpdate.GetWorkspace()
		h.toAll(sessions, id, shared)
	case *v1.DispatchEvent_WorkspaceDelete:
		h.toAll(sessions, id, shared)
		for _, s := range sessions {
			h.leaveWorkspace(s, wid)
		}
	default: // categories and other workspace-wide events
		h.toAll(sessions, id, shared)
	}
}

// changesVisibility reports events that may change which members a guest sees (st.mu held).
// A ROOM_UPDATE that keeps overrides and category (rename, topic, media settings) does not,
// so the common case skips the recomputation (review B2).
func changesVisibility(st *wsState, ev *v1.DispatchEvent) bool {
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_RoomUpdate:
		r := e.RoomUpdate.GetRoom()
		return !st.sameVisibility(parseID(r.GetId()), r)
	case *v1.DispatchEvent_RoomCreate, *v1.DispatchEvent_RoomPermissionsUpdate,
		*v1.DispatchEvent_RoomDelete, *v1.DispatchEvent_WorkspaceMemberAdd, *v1.DispatchEvent_WorkspaceMemberUpdate,
		*v1.DispatchEvent_WorkspaceMemberRemove:
		return true
	}
	return false
}

// syncGuestMembers sends guests synthetic MEMBER_ADD (+ presence) for members that became
// visible and MEMBER_REMOVE for those that became hidden (st.mu held). Member profiles are
// loaded off the fan-out path; the guest's session is paused meanwhile to keep order.
// The event's own subject is covered by the event itself.
func (h *Hub) syncGuestMembers(st *wsState, wid uuid.UUID, before map[*Session]map[uuid.UUID]bool, subject uuid.UUID) {
	for s, was := range before {
		now := st.guestVisible(s.user)
		var added []uuid.UUID
		for u := range now {
			if !was[u] && u != subject {
				added = append(added, u)
			}
		}
		for u := range was {
			if !now[u] && u != subject && u != s.user {
				s.dispatch(uuid.New(), &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberRemove{
					WorkspaceMemberRemove: &v1.WorkspaceMemberRemove{WorkspaceId: wid.String(), UserId: u.String()}}})
			}
		}
		if len(added) == 0 {
			continue
		}
		marker := s.pause()
		go func(s *Session, added []uuid.UUID, marker *pauseMark) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var evs []pendingEvent
			pres, _ := h.pres.get(ctx, added)
			for _, u := range added {
				row, err := h.db.Q.GetMemberWithUser(ctx, sqlc.GetMemberWithUserParams{WorkspaceID: wid, UserID: u})
				if err != nil {
					continue
				}
				evs = append(evs, pendingEvent{id: uuid.New(), enc: newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberAdd{
					WorkspaceMemberAdd: &v1.WorkspaceMemberAdd{Member: pbconv.Member(row.WorkspaceMember, row.User)}}})})
				if p := pres[u]; p != nil {
					evs = append(evs, pendingEvent{id: uuid.New(), enc: newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_PresenceUpdate{
						PresenceUpdate: &v1.PresenceUpdate{Presence: p}}})})
				}
			}
			s.resumeMany(marker, evs)
		}(s, added, marker)
	}
}

func (h *Hub) toAll(sessions []*Session, id uuid.UUID, enc *encEvent) {
	for _, s := range sessions {
		s.dispatchEnc(id, enc)
	}
}

func (h *Hub) toViewers(sessions []*Session, view func(rid, uid uuid.UUID) bool, rid, id uuid.UUID, enc *encEvent) {
	for _, s := range sessions {
		if view(rid, s.user) {
			s.dispatchEnc(id, enc)
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
		// Filling the snapshot needs Redis and loading the state needs Postgres: neither may
		// run on the fan-out path (M2). The user's sessions pause, so events that follow
		// keep their order behind the snapshot.
		snap := e.WorkspaceCreate.GetSnapshot()
		wid := parseID(snap.GetWorkspace().GetId())
		markers := make([]*pauseMark, len(sessions))
		for i, s := range sessions {
			h.joinWorkspace(s, wid)
			markers[i] = s.pause()
		}
		h.startState(wid)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			h.fillLive(ctx, wid, snap)
			enc := newEnc(ev)
			for i, s := range sessions {
				s.resume(markers[i], id, enc)
			}
		}()
		return
	case *v1.DispatchEvent_WorkspaceDelete:
		wid := parseID(e.WorkspaceDelete.GetWorkspaceId())
		defer func() {
			for _, s := range sessions {
				h.leaveWorkspace(s, wid)
			}
		}()
	}
	enc := newEnc(ev)
	for _, s := range sessions {
		s.dispatchEnc(id, enc)
	}
}

// fillLive adds Redis-backed parts (voice states, presences, call start times) to a
// snapshot. Only members listed in the snapshot are included (guests see a filtered list).
func (h *Hub) fillLive(ctx context.Context, wid uuid.UUID, snap *v1.WorkspaceSnapshot) {
	visible := map[uuid.UUID]bool{}
	var voiceRooms []uuid.UUID
	for _, r := range snap.GetRooms() {
		id := parseID(r.GetId())
		visible[id] = true
		if r.GetType() == v1.RoomType_ROOM_TYPE_VOICE {
			voiceRooms = append(voiceRooms, id)
		}
	}
	if started, err := h.voice.StartedAt(ctx, voiceRooms); err == nil {
		for _, r := range snap.GetRooms() {
			if t, ok := started[parseID(r.GetId())]; ok {
				r.VoiceStartedAt = timestamppb.New(t)
			}
		}
	}
	members := map[string]bool{}
	users := make([]uuid.UUID, 0, len(snap.GetMembers()))
	for _, m := range snap.GetMembers() {
		members[m.GetUser().GetId()] = true
		users = append(users, parseID(m.GetUser().GetId()))
	}
	if states, err := h.voice.States(ctx, wid); err == nil {
		snap.VoiceStates = nil
		for _, vs := range states {
			if members[vs.GetUserId()] {
				snap.VoiceStates = append(snap.VoiceStates, sanitizeVoice(vs, func(rid uuid.UUID) bool { return visible[rid] }))
			}
		}
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
	s.closeQueue()
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
			// Confirm only a session that was live here and is now flushed: a session that
			// was already released (shutdown) or destroyed has an unbuffered gap (review R2).
			if s != nil && h.release(s, "resumed elsewhere", false) && len(f) > 2 {
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
// forget it locally without touching Redis state. graceful lets already queued frames
// (e.g. RECONNECT) reach the client before the close.
func (h *Hub) release(s *Session, why string, graceful bool) bool {
	s.mu.Lock()
	if s.dead {
		s.mu.Unlock()
		return false
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
		if graceful {
			c.closeGraceful(4000, why)
		} else {
			c.closeNow(4000, why)
		}
	}
	h.unregister(s)
	s.flush()
	s.closeQueue()
	return !s.broken.Load()
}

// Shutdown asks every client to reconnect (spread over cfg.ShutdownSpread to avoid a
// thundering herd). Events published after a session is released are not buffered by
// anyone, so its RESUME gets INVALID_SESSION and the client re-IDENTIFYs (no silent loss).
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
			// Owner "" first = released without a successor: a RESUME elsewhere, even one
			// racing this shutdown, is answered with INVALID_SESSION (H1, review R2).
			_ = h.buf.setOwner(context.WithoutCancel(ctx), s.id, "")
			h.release(s, "server restart", true)
		}()
	}
	wg.Wait()
}
