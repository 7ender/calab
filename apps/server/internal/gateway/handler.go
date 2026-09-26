package gateway

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/workspaces"
)

const (
	identifyTimeout = 30 * time.Second
	maxSubscribed   = 100
	typingInterval  = 3 * time.Second
)

func statusCode(c int) websocket.StatusCode { return websocket.StatusCode(c) } //nolint:gosec // close codes

// ServeHTTP upgrades GET /gateway to a WebSocket and runs the connection.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.closing.Load() {
		http.Error(w, "shutting down", http.StatusServiceUnavailable)
		return
	}
	if !OriginAllowed(r.Header.Get("Origin"), r.Header.Get("Cookie") != "", h.cfg.AllowedOrigins) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin is checked above (OriginAllowed); coder/websocket's OriginPatterns cannot
		// express Electron's file:// / "null" origins.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(readLimit)
	c := newConn(ws, codec{json: r.URL.Query().Get("encoding") == "json"})
	go c.writeLoop()
	c.sendFrame(&v1.GatewayFrame{Payload: &v1.GatewayFrame_Hello{Hello: &v1.Hello{
		HeartbeatIntervalMs: uint32(h.cfg.HeartbeatInterval.Milliseconds()), //nolint:gosec // seconds-scale
	}}})
	h.serve(c)
}

// OriginAllowed decides whether a WebSocket upgrade may proceed. Authentication is the
// IDENTIFY token (never a cookie), so this is defence in depth against foreign web pages:
//   - no Origin: native clients (tests, tools) — allowed;
//   - "null" / file://: the packaged Electron renderer — allowed only without cookies (the
//     desktop never sends any; a cookie-carrying "null" origin is a sandboxed foreign page);
//   - http://localhost / 127.0.0.1 (any port): local development (Vite dev server) — allowed;
//   - otherwise the origin must be one of the web client's origins.
func OriginAllowed(origin string, hasCookie bool, allowed []string) bool {
	if origin == "" {
		return true
	}
	if origin == "null" || strings.HasPrefix(origin, "file://") {
		return !hasCookie
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1") {
		return true
	}
	return slices.Contains(allowed, strings.ToLower(origin))
}

type readResult int

const (
	readOK readResult = iota
	readTimeout
	readClosed
	readBadFrame
)

func (h *Hub) read(c *conn, timeout time.Duration) (*v1.GatewayFrame, readResult, error) {
	ctx, cancel := context.WithTimeout(c.ctx, timeout)
	defer cancel()
	typ, b, err := c.ws.Read(ctx)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) && c.ctx.Err() == nil {
			return nil, readTimeout, err
		}
		return nil, readClosed, err
	}
	f, err := c.codec.decode(typ, b)
	if err != nil || f.GetOp() != opOf(f) || f.GetPayload() == nil {
		return nil, readBadFrame, err
	}
	return f, readOK, nil
}

func (h *Hub) serve(c *conn) {
	defer c.finish()
	var s *Session
	// Until IDENTIFY / RESUME succeeds only HEARTBEAT is allowed.
	for s == nil {
		f, res, _ := h.read(c, identifyTimeout)
		switch res {
		case readTimeout:
			c.closeGraceful(4003, "identify timeout")
			return
		case readClosed:
			return
		case readBadFrame:
			c.closeGraceful(4002, "decode error")
			return
		}
		switch p := f.GetPayload().(type) {
		case *v1.GatewayFrame_Heartbeat:
			c.sendFrame(&v1.GatewayFrame{Payload: &v1.GatewayFrame_HeartbeatAck{HeartbeatAck: &v1.HeartbeatAck{}}})
		case *v1.GatewayFrame_Identify:
			s = h.identify(c, p.Identify)
			if s == nil {
				return
			}
		case *v1.GatewayFrame_Resume:
			var retry bool
			s, retry = h.resume(c, p.Resume)
			if s == nil && !retry {
				return
			}
		default:
			c.closeGraceful(4003, "not authenticated")
			return
		}
	}
	h.loop(c, s)
}

func (h *Hub) loop(c *conn, s *Session) {
	timeout := 2*h.cfg.HeartbeatInterval + 10*time.Second
	for {
		f, res, err := h.read(c, timeout)
		switch res {
		case readTimeout:
			h.destroy(s, 4009, "heartbeat timeout")
			return
		case readBadFrame:
			c.closeGraceful(4002, "decode error")
			s.detach(c)
			return
		case readClosed:
			if c.isServerClosed() {
				s.detach(c)
				return
			}
			switch websocket.CloseStatus(err) {
			case websocket.StatusNormalClosure, websocket.StatusGoingAway:
				h.destroy(s, 0, "client closed") // app quit / logout: not resumable, offline now
			default:
				s.detach(c) // network loss: resumable
			}
			return
		}
		ok, flood := c.inbound()
		if flood {
			c.closeGraceful(4008, "rate limited")
			s.detach(c)
			return
		}
		if !ok && !softExempt(s, f) {
			continue // over the soft budget: drop SUBSCRIBE / TYPING / repeated PRESENCE, keep the socket
		}
		switch p := f.GetPayload().(type) {
		case *v1.GatewayFrame_Heartbeat:
			c.sendFrame(&v1.GatewayFrame{Payload: &v1.GatewayFrame_HeartbeatAck{HeartbeatAck: &v1.HeartbeatAck{}}})
			h.touch(s)
		case *v1.GatewayFrame_SetPresence:
			h.setPresence(s, p.SetPresence.GetStatus())
		case *v1.GatewayFrame_Typing:
			h.typing(s, p.Typing.GetRoomId())
		case *v1.GatewayFrame_Subscribe:
			s.setSubscribed(p.Subscribe.GetRoomIds())
		default:
			c.closeGraceful(4001, "unexpected opcode")
			s.detach(c)
			return
		}
	}
}

// authenticate validates the access token; it closes the socket on failure.
func (h *Hub) authenticate(c *conn, token string) (auth.Identity, bool) {
	id, err := h.auth.Tokens().Parse(token)
	if err != nil {
		c.closeGraceful(4004, "authentication failed")
		return id, false
	}
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()
	revoked, err := h.auth.IsRevoked(ctx, id.SessionID)
	if err != nil {
		c.closeGraceful(4000, "try again")
		return id, false
	}
	if revoked {
		c.closeGraceful(4010, "session revoked")
		return id, false
	}
	return id, true
}

func deviceKey(user uuid.UUID) string     { return "gw:user:" + user.String() }
func asessKey(asess uuid.UUID) string     { return "gw:asess:" + asess.String() }
func typingKey(r, u uuid.UUID) string     { return "gw:typing:" + r.String() + ":" + u.String() }
func expiryScore(d time.Duration) float64 { return float64(time.Now().Add(d).UnixMilli()) }

// claimScript atomically enforces the per-user device limit and binds the auth session
// (device) to the new gateway session (L1). Returns the previous gateway session of the
// same device ("" if none), or false when the limit is reached.
var claimScript = rueidis.NewLuaScript(`
local zkey, akey = KEYS[1], KEYS[2]
local now, expiry, max, asess, gsid, ttl = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4], ARGV[5], tonumber(ARGV[6])
redis.call('ZREMRANGEBYSCORE', zkey, '-inf', now)
local same = redis.call('ZSCORE', zkey, asess)
if not same and redis.call('ZCARD', zkey) >= max then return false end
redis.call('ZADD', zkey, expiry, asess)
redis.call('EXPIRE', zkey, ttl)
local prev = redis.call('GET', akey)
redis.call('SET', akey, gsid, 'EX', ttl)
if prev and prev ~= gsid then return prev end
return ''`)

// forgetScript removes the device binding only if it still points to this gateway
// session (a newer session of the same device must not be unbound).
var forgetScript = rueidis.NewLuaScript(`
if redis.call('GET', KEYS[2]) == ARGV[1] then
  redis.call('DEL', KEYS[2])
  redis.call('ZREM', KEYS[1], ARGV[2])
end
return 1`)

// claimDevice enforces the per-user device limit. One auth session (device) has at most
// one gateway session: a new IDENTIFY from the same device replaces the previous one.
func (h *Hub) claimDevice(ctx context.Context, user, asess, gsid uuid.UUID) (bool, error) {
	ttl := 2*h.cfg.HeartbeatInterval + resumeWindow
	res := claimScript.Exec(ctx, h.redis, []string{deviceKey(user), asessKey(asess)}, []string{
		strconv.FormatInt(time.Now().UnixMilli(), 10), strconv.FormatInt(int64(expiryScore(ttl)), 10),
		strconv.Itoa(h.cfg.MaxSessionsPerUser), asess.String(), gsid.String(), strconv.Itoa(int(ttl.Seconds())),
	})
	prev, err := res.ToString()
	if rueidis.IsRedisNil(err) {
		return false, nil // limit reached (Lua false → nil)
	}
	if err != nil {
		return false, err
	}
	if prev != "" {
		h.kill(ctx, parseID(prev))
	}
	return true, nil
}

// kill destroys a gateway session wherever it lives.
func (h *Hub) kill(ctx context.Context, gsid uuid.UUID) {
	h.mu.RLock()
	s := h.sessions[gsid]
	h.mu.RUnlock()
	if s != nil {
		go h.destroy(s, 4000, "replaced by a new session") //nolint:gosec // G118: teardown must outlive the request
		return
	}
	if m, ok, err := h.buf.meta(ctx, gsid); err == nil && ok && m.owner != "" {
		h.sendControl(ctx, m.owner, "kill "+gsid.String())
	}
	h.buf.drop(ctx, gsid)
}

func (h *Hub) forgetDevice(ctx context.Context, s *Session) {
	_ = forgetScript.Exec(ctx, h.redis, []string{deviceKey(s.user), asessKey(s.asess)}, []string{s.id.String(), s.asess.String()}).Error()
}

func (h *Hub) touch(s *Session) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	s.mu.Lock()
	st := s.status
	s.mu.Unlock()
	ttl := 2*h.cfg.HeartbeatInterval + resumeWindow
	_ = h.pres.set(ctx, s.user, s.id, st)
	h.buf.touch(ctx, s.id)
	h.redis.DoMulti(ctx,
		h.redis.B().Zadd().Key(deviceKey(s.user)).ScoreMember().ScoreMember(expiryScore(ttl), s.asess.String()).Build(),
		h.redis.B().Expire().Key(asessKey(s.asess)).Seconds(int64(ttl.Seconds())).Build())
}

func (h *Hub) identify(c *conn, req *v1.Identify) *Session {
	id, ok := h.authenticate(c, req.GetToken())
	if !ok {
		return nil
	}
	ctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
	defer cancel()
	gsid := uuid.New()
	allowed, err := h.claimDevice(ctx, id.UserID, id.SessionID, gsid)
	if err != nil {
		c.closeGraceful(4000, "try again")
		return nil
	}
	if !allowed {
		c.closeGraceful(4008, "too many active devices")
		return nil
	}
	wids, err := h.db.Q.ListUserWorkspaceIDs(ctx, id.UserID)
	if err != nil {
		c.closeGraceful(4000, "try again")
		return nil
	}
	if err := h.buf.create(ctx, gsid, id.UserID, id.SessionID, h.instance); err != nil {
		c.closeGraceful(4000, "try again")
		return nil
	}
	s := newSession(h, gsid, id.UserID, id.SessionID)
	// Register first so that events published while READY is being built are queued.
	h.register(s, wids)
	for _, w := range wids {
		h.ensureState(ctx, w)
	}
	_ = h.pres.set(ctx, s.user, s.id, s.status)
	ready, err := h.buildReady(ctx, s, id.UserID)
	if err != nil {
		slog.Error("gateway: build READY", "err", err)
		h.destroy(s, 4000, "try again")
		return nil
	}
	s.mu.Lock()
	s.attachLocked(c)
	s.ready = true
	s.emit(uuid.New(), newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_Ready{Ready: ready}}))
	s.flushPending(nil)
	s.mu.Unlock()
	h.publishPresence(ctx, s.user)
	return s
}

func (h *Hub) buildReady(ctx context.Context, s *Session, uid uuid.UUID) (*v1.Ready, error) {
	u, err := h.db.Q.GetUser(ctx, uid)
	if err != nil {
		return nil, err
	}
	res := perm.NewResolver(h.db.Q)
	wss, err := h.db.Q.ListUserWorkspaces(ctx, uid)
	if err != nil {
		return nil, err
	}
	ready := &v1.Ready{SessionId: s.id.String(), Me: pbconv.Me(u)}
	for _, w := range wss {
		role, err := res.Role(ctx, w.ID, uid)
		if err != nil {
			continue
		}
		snap, err := workspaces.Snapshot(ctx, h.db.Q, w, uid, role)
		if err != nil {
			return nil, err
		}
		h.fillLive(ctx, w.ID, snap)
		ready.Workspaces = append(ready.Workspaces, snap)
	}
	// Read state with unread / mention counts for every room the user can see now (also
	// rooms never opened: review 4 M1).
	var visible []uuid.UUID
	for _, snap := range ready.Workspaces {
		for _, r := range snap.GetRooms() {
			visible = append(visible, parseID(r.GetId()))
		}
	}
	rs, err := h.db.Q.ListReadStates(ctx, sqlc.ListReadStatesParams{UserID: uid, RoomIds: visible})
	if err != nil {
		return nil, err
	}
	for _, r := range rs {
		marker := "" // never read: counts start at the user's joining of the workspace
		if r.LastReadMessageID != nil {
			marker = r.LastReadMessageID.String()
		}
		ready.ReadStates = append(ready.ReadStates, &v1.ReadState{
			RoomId: r.RoomID.String(), LastReadMessageId: marker,
			UnreadCount: uint32(max(r.UnreadCount, 0)), MentionCount: uint32(max(r.MentionCount, 0)), //nolint:gosec // 0..999
		})
	}
	ns, err := h.db.Q.ListRoomNotificationSettings(ctx, sqlc.ListRoomNotificationSettingsParams{UserID: uid, RoomIds: visible})
	if err != nil {
		return nil, err
	}
	for _, n := range ns {
		ready.NotificationSettings = append(ready.NotificationSettings, pbconv.RoomNotificationSettings(n))
	}
	return ready, nil
}

func (h *Hub) invalid(c *conn) {
	c.sendFrame(&v1.GatewayFrame{Payload: &v1.GatewayFrame_InvalidSession{InvalidSession: &v1.InvalidSession{Resumable: false}}})
}

// resume re-attaches a socket to an existing session and replays missed events. When
// continuity cannot be guaranteed — unknown / expired session, owner released it on
// shutdown, owner dead, or the handover was not confirmed — it answers
// INVALID_SESSION{resumable:false} and returns retry=true so the client can IDENTIFY on the
// same socket. A RESUME therefore never silently drops events (security review H1).
func (h *Hub) resume(c *conn, req *v1.Resume) (s *Session, retry bool) {
	id, ok := h.authenticate(c, req.GetToken())
	if !ok {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
	defer cancel()
	gsid, err := uuid.Parse(req.GetSessionId())
	if err != nil {
		h.invalid(c)
		return nil, true
	}
	meta, found, err := h.buf.meta(ctx, gsid)
	if err != nil || !found || meta.user != id.UserID || meta.asess != id.SessionID {
		h.invalid(c)
		return nil, true
	}
	h.mu.RLock()
	local := h.sessions[gsid]
	h.mu.RUnlock()
	if local != nil {
		ok = h.replayLocal(ctx, local, c, req.GetSeq())
	} else if local = h.takeover(ctx, gsid, meta); local != nil {
		ok = h.replayTakenOver(ctx, local, c, req.GetSeq())
	}
	if local == nil || !ok {
		if local != nil {
			// Detach this socket first so destroying the session does not close it before
			// INVALID_SESSION goes out (review R4): the client then IDENTIFYs right here.
			local.mu.Lock()
			if local.conn == c {
				local.conn = nil
				h.sockets(-1)
			}
			local.mu.Unlock()
			c.setReplay(nil)
			h.destroy(local, 0, "")
		}
		h.invalid(c)
		return nil, true
	}
	h.touch(local)
	h.publishPresence(ctx, local.user)
	return local, false
}

// takeover moves a session from another live instance to this one. It succeeds only if
// the owner confirms the release (it has then flushed everything it dispatched into the
// buffer); events for the session arriving here meanwhile wait in the pending queue.
func (h *Hub) takeover(ctx context.Context, gsid uuid.UUID, meta sessMeta) *Session {
	if meta.owner == "" || meta.owner == h.instance {
		return nil // released on shutdown (or lost here): nobody buffered the gap
	}
	alive, err := h.redis.Do(ctx, h.redis.B().Exists().Key(instKey(meta.owner)).Build()).AsInt64()
	if err != nil || alive == 0 {
		return nil // owner crashed: its unflushed and later events are gone
	}
	wids, err := h.db.Q.ListUserWorkspaceIDs(ctx, meta.user)
	if err != nil {
		return nil
	}
	s := newSession(h, gsid, meta.user, meta.asess)
	h.register(s, wids) // events from now on are queued (s.ready=false)
	for _, w := range wids {
		h.ensureState(ctx, w)
	}
	ch := make(chan struct{})
	h.mu.Lock()
	h.releases[gsid] = ch
	h.mu.Unlock()
	h.sendControl(ctx, meta.owner, "release "+gsid.String()+" "+h.instance)
	confirmed := false
	select {
	case <-ch:
		confirmed = true
	case <-time.After(3 * time.Second):
	case <-ctx.Done():
	}
	h.mu.Lock()
	delete(h.releases, gsid)
	h.mu.Unlock()
	if !confirmed || h.buf.setOwner(ctx, gsid, h.instance) != nil {
		h.abandon(s)
		return nil
	}
	return s
}

// abandon forgets a session that never became usable (no Redis cleanup: another instance
// or the TTL owns that).
func (h *Hub) abandon(s *Session) {
	s.mu.Lock()
	s.dead = true
	s.mu.Unlock()
	h.unregister(s)
	s.closeQueue()
}

func transcodeAll(c *conn, es []entry) ([]outMsg, bool) {
	out := make([]outMsg, 0, len(es))
	for _, e := range es {
		typ, b, err := c.codec.transcode(e.frame)
		if err != nil {
			return nil, false
		}
		out = append(out, outMsg{typ: typ, data: b})
	}
	return out, true
}

// replayLocal resumes a session owned here without holding s.mu during Redis I/O (M2):
// the socket is attached "held" (new events queue behind), the buffer is flushed and read,
// and the missed frames are released ahead of the queue.
func (h *Hub) replayLocal(ctx context.Context, s *Session, c *conn, clientSeq uint64) bool {
	c.hold()
	s.mu.Lock()
	if s.dead || s.broken.Load() {
		s.mu.Unlock()
		c.setReplay(nil)
		return false
	}
	upTo := s.seq
	s.attachLocked(c)
	s.mu.Unlock()

	s.flush() // everything up to upTo is in Redis now
	entries, err := h.buf.entries(ctx, s.id)
	if err != nil || s.broken.Load() {
		c.setReplay(nil)
		return false
	}
	missed, ok := since(entries, clientSeq, upTo)
	if !ok {
		c.setReplay(nil)
		return false
	}
	kept := missed[:0]
	for _, e := range missed {
		if e.seq <= upTo { // later frames are already queued on the socket
			kept = append(kept, e)
		}
	}
	frames, ok := transcodeAll(c, kept)
	if !ok {
		c.setReplay(nil)
		return false
	}
	c.setReplay(frames)
	s.mu.Lock()
	s.emit(uuid.New(), newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_Resumed{Resumed: &v1.Resumed{Replayed: uint32(len(kept))}}})) //nolint:gosec // ≤ 1000
	s.mu.Unlock()
	return true
}

// replayTakenOver finishes a takeover: the released buffer is read without locks (events
// for the session wait in pending), then numbering continues and pending events follow.
func (h *Hub) replayTakenOver(ctx context.Context, s *Session, c *conn, clientSeq uint64) bool {
	meta, ok, err := h.buf.meta(ctx, s.id)
	if err != nil || !ok {
		return false
	}
	entries, err := h.buf.entries(ctx, s.id)
	if err != nil {
		return false
	}
	missed, ok := since(entries, clientSeq, meta.seq)
	if !ok {
		return false
	}
	frames, ok := transcodeAll(c, missed)
	if !ok {
		return false
	}
	skip := make(map[uuid.UUID]bool, len(entries))
	for _, e := range entries {
		skip[e.id] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead {
		return false
	}
	s.seq = meta.seq
	s.attachLocked(c)
	c.setReplay(frames)
	s.ready = true
	s.flushPending(skip)
	s.emit(uuid.New(), newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_Resumed{Resumed: &v1.Resumed{Replayed: uint32(len(missed))}}})) //nolint:gosec // ≤ 1000
	return true
}

// softExempt reports frames processed even over the soft inbound budget: heartbeats, and a
// PRESENCE_UPDATE that actually changes the status (review B4) — dropping it silently would
// leave the user's status wrong until the next change. Repeats are still dropped; the hard
// flood limit applies to everything.
func softExempt(s *Session, f *v1.GatewayFrame) bool {
	switch p := f.GetPayload().(type) {
	case *v1.GatewayFrame_Heartbeat:
		return true
	case *v1.GatewayFrame_SetPresence:
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.status != p.SetPresence.GetStatus()
	}
	return false
}

func (h *Hub) setPresence(s *Session, st v1.PresenceStatus) {
	switch st {
	case v1.PresenceStatus_PRESENCE_STATUS_ONLINE, v1.PresenceStatus_PRESENCE_STATUS_IDLE,
		v1.PresenceStatus_PRESENCE_STATUS_DND, v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE:
	default:
		return
	}
	s.mu.Lock()
	same := s.status == st
	s.status = st
	s.mu.Unlock()
	if same {
		return // debounce: no Redis write / broadcast for a repeated status (M3)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := h.pres.set(ctx, s.user, s.id, st); err == nil {
		h.publishPresence(ctx, s.user)
	}
}

// typing publishes TYPING_START (VIEW_ROOM + SEND_MESSAGES; at most once per 3 s per user
// and room across devices).
func (h *Hub) typing(s *Session, roomIDStr string) {
	rid, err := uuid.Parse(roomIDStr)
	if err != nil {
		return
	}
	var wid uuid.UUID
	s.mu.Lock()
	wss := make([]uuid.UUID, 0, len(s.workspaces))
	for w := range s.workspaces {
		wss = append(wss, w)
	}
	s.mu.Unlock()
	allowed := false
	for _, w := range wss {
		st := h.state(w)
		if st == nil {
			continue
		}
		st.mu.RLock()
		if st.rooms[rid] != nil {
			wid, allowed = w, st.bits(rid, s.user).Has(perm.ViewRoom|perm.SendMessages)
		}
		st.mu.RUnlock()
		if wid != uuid.Nil {
			break
		}
	}
	if !allowed {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if isNil(h.redis.Do(ctx, h.redis.B().Set().Key(typingKey(rid, s.user)).Value("1").Nx().Ex(typingInterval).Build()).Error()) {
		return // rate limited
	}
	h.pub.Workspace(ctx, wid, &v1.DispatchEvent{Event: &v1.DispatchEvent_TypingStart{TypingStart: &v1.TypingStart{
		RoomId: rid.String(), UserId: s.user.String(), Timestamp: nowTS(),
	}}})
}

func (s *Session) setSubscribed(ids []string) {
	m := map[uuid.UUID]bool{}
	for _, id := range ids {
		if r, err := uuid.Parse(id); err == nil && len(m) < maxSubscribed {
			m[r] = true
		}
	}
	s.mu.Lock()
	s.subscribed = m
	s.mu.Unlock()
}

func (s *Session) isSubscribed(rid uuid.UUID) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.subscribed[rid]
}
