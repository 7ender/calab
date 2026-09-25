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

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
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
	if !OriginAllowed(r.Header.Get("Origin"), h.cfg.AllowedOrigins) {
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
//   - "null" / file://: the packaged Electron renderer — allowed;
//   - http://localhost / 127.0.0.1 (any port): local development (Vite dev server) — allowed;
//   - otherwise the origin must be one of the web client's origins.
func OriginAllowed(origin string, allowed []string) bool {
	if origin == "" || origin == "null" || strings.HasPrefix(origin, "file://") {
		return true
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

// claimDevice enforces the per-user device limit. One auth session (device) has at most
// one gateway session: a new IDENTIFY from the same device replaces the previous one.
func (h *Hub) claimDevice(ctx context.Context, user, asess, gsid uuid.UUID) (bool, error) {
	key := deviceKey(user)
	now := strconv.FormatInt(time.Now().UnixMilli(), 10)
	res := h.redis.DoMulti(ctx,
		h.redis.B().Zremrangebyscore().Key(key).Min("-inf").Max(now).Build(),
		h.redis.B().Zscore().Key(key).Member(asess.String()).Build(),
		h.redis.B().Zcard().Key(key).Build(),
		h.redis.B().Get().Key(asessKey(asess)).Build())
	for _, r := range res[:3] {
		if err := r.Error(); err != nil && !isNil(err) {
			return false, err
		}
	}
	_, scoreErr := res[1].AsFloat64()
	sameDevice := scoreErr == nil
	n, _ := res[2].AsInt64()
	if !sameDevice && n >= int64(h.cfg.MaxSessionsPerUser) {
		return false, nil
	}
	if prev, err := res[3].ToString(); err == nil && prev != gsid.String() {
		h.kill(ctx, parseID(prev))
	}
	ttl := 2*h.cfg.HeartbeatInterval + resumeWindow
	h.redis.DoMulti(ctx,
		h.redis.B().Zadd().Key(key).ScoreMember().ScoreMember(expiryScore(ttl), asess.String()).Build(),
		h.redis.B().Expire().Key(key).Seconds(int64(ttl.Seconds())).Build(),
		h.redis.B().Set().Key(asessKey(asess)).Value(gsid.String()).Ex(ttl).Build())
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
	if cur, err := h.redis.Do(ctx, h.redis.B().Get().Key(asessKey(s.asess)).Build()).ToString(); err == nil && cur == s.id.String() {
		h.redis.DoMulti(ctx,
			h.redis.B().Del().Key(asessKey(s.asess)).Build(),
			h.redis.B().Zrem().Key(deviceKey(s.user)).Member(s.asess.String()).Build())
	}
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
	s.attachLocked(c, nil)
	s.emit(uuid.New(), &v1.DispatchEvent{Event: &v1.DispatchEvent_Ready{Ready: ready}})
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
	rs, err := h.db.Q.ListReadStates(ctx, uid)
	if err != nil {
		return nil, err
	}
	for _, r := range rs {
		ready.ReadStates = append(ready.ReadStates, &v1.ReadState{RoomId: r.RoomID.String(), LastReadMessageId: r.LastReadMessageID.String()})
	}
	return ready, nil
}

func (h *Hub) invalid(c *conn) {
	c.sendFrame(&v1.GatewayFrame{Payload: &v1.GatewayFrame_InvalidSession{InvalidSession: &v1.InvalidSession{Resumable: false}}})
}

// resume re-attaches a socket to an existing session and replays missed events. On an
// unknown / expired session it sends INVALID_SESSION{resumable:false} and returns retry=true
// so the client can IDENTIFY on the same socket.
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
	if local == nil {
		local = h.takeover(ctx, gsid, meta)
		if local == nil {
			h.invalid(c)
			return nil, true
		}
	}
	if !h.replay(ctx, local, c, req.GetSeq()) {
		h.destroy(local, 0, "")
		h.invalid(c)
		return nil, true
	}
	h.touch(local)
	h.publishPresence(ctx, local.user)
	return local, false
}

// takeover moves a session owned by another (or a dead) instance to this one.
func (h *Hub) takeover(ctx context.Context, gsid uuid.UUID, meta sessMeta) *Session {
	s := newSession(h, gsid, meta.user, meta.asess)
	wids, err := h.db.Q.ListUserWorkspaceIDs(ctx, meta.user)
	if err != nil {
		return nil
	}
	h.register(s, wids) // events from now on are queued (s.ready=false)
	for _, w := range wids {
		h.ensureState(ctx, w)
	}
	if meta.owner != "" && meta.owner != h.instance {
		alive, _ := h.redis.Do(ctx, h.redis.B().Exists().Key(instKey(meta.owner)).Build()).AsInt64()
		if alive > 0 {
			ch := make(chan struct{})
			h.mu.Lock()
			h.releases[gsid] = ch
			h.mu.Unlock()
			h.sendControl(ctx, meta.owner, "release "+gsid.String()+" "+h.instance)
			select {
			case <-ch:
			case <-time.After(3 * time.Second):
			case <-ctx.Done():
			}
		}
	}
	if err := h.buf.setOwner(ctx, gsid, h.instance); err != nil {
		h.unregister(s)
		return nil
	}
	return s
}

// replay sends buffered events after clientSeq and attaches the socket.
func (h *Hub) replay(ctx context.Context, s *Session, c *conn, clientSeq uint64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead {
		return false
	}
	if s.ready {
		s.flush() // everything emitted so far is in Redis
	}
	if s.broken.Load() {
		return false
	}
	entries, err := h.buf.entries(ctx, s.id)
	if err != nil {
		return false
	}
	last := s.seq
	if !s.ready { // taken over from another instance: continue its numbering
		meta, ok, err := h.buf.meta(ctx, s.id)
		if err != nil || !ok {
			return false
		}
		last = meta.seq
		s.seq = meta.seq
	}
	missed, ok := since(entries, clientSeq, last)
	if !ok {
		return false
	}
	out := make([]outMsg, 0, len(missed))
	for _, e := range missed {
		typ, b, err := c.codec.transcode(e.frame)
		if err != nil {
			return false
		}
		out = append(out, outMsg{typ: typ, data: b})
	}
	s.attachLocked(c, out)
	if !s.ready {
		skip := map[uuid.UUID]bool{}
		for _, e := range entries {
			skip[e.id] = true
		}
		s.flushPending(skip)
	}
	s.emit(uuid.New(), &v1.DispatchEvent{Event: &v1.DispatchEvent_Resumed{Resumed: &v1.Resumed{Replayed: uint32(len(missed))}}}) //nolint:gosec // ≤ 1000
	return true
}

func (h *Hub) setPresence(s *Session, st v1.PresenceStatus) {
	switch st {
	case v1.PresenceStatus_PRESENCE_STATUS_ONLINE, v1.PresenceStatus_PRESENCE_STATUS_IDLE,
		v1.PresenceStatus_PRESENCE_STATUS_DND, v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE:
	default:
		return
	}
	s.mu.Lock()
	s.status = st
	s.mu.Unlock()
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
