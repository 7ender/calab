package gateway

import (
	"context"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/redisx"
)

// Gateway sessions of one auth session (#40).
//
// An auth session is a device: it counts toward the per-user device limit and it owns voice
// (LiveKit identity "<user_id>:<session_id>", one device in voice at a time, rtc/devices.go).
// The tabs of one browser share the auth session (cookie + storage), so a single gateway
// session per auth session made them evict each other in a loop (close 4000 → RESUME fails →
// IDENTIFY → evicts the other tab → …). Instead each tab sends its own Identify.tab_id and
// keeps its own gateway session:
//
//   - a new IDENTIFY replaces only the gateway session of the same (auth session, tab_id): a
//     reloaded tab or a re-IDENTIFY after a failed RESUME drops its own leftover. Desktop and
//     bots send no tab_id: one gateway session per auth session, exactly as before;
//   - at most MaxTabsPerSession tabs per auth session; above it the one claimed (IDENTIFY or
//     RESUME) longest ago is evicted with 4011, and its client reconnects only once the tab is
//     shown again, so evictions never ping-pong between background tabs;
//   - everything owned by the auth session stays single: the device count, voice (LiveKit
//     drops a duplicate identity, the other tab leaves with «в другом окне»), identity checks
//     and leases are evaluated per gateway session against the same auth session, and a
//     revocation closes every gateway session of it (hub.go, session:revoked:<id>).
//
// Redis:
//
//	gw:user:<user>   zset asess → expiry ms (the device limit, renewed by heartbeats)
//	gw:tabs:<asess>  zset "<tab_id>|<gsid>" → claim time ms; TTL renewed by heartbeats

const maxTabIDLen = 64

// validTabID returns id when it is a sane tab id (1–64 of [A-Za-z0-9_-]), else "" (the
// device itself): a malformed value must never collide with or evict another tab's session.
func validTabID(id string) string {
	if id == "" || len(id) > maxTabIDLen {
		return ""
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '-' && c != '_' {
			return ""
		}
	}
	return id
}

func deviceKey(user uuid.UUID) string { return redisx.Key("gw:user:" + user.String()) }
func tabsKey(asess uuid.UUID) string  { return redisx.Key("gw:tabs:" + asess.String()) }
func tabMember(tab string, gsid uuid.UUID) string {
	return tab + "|" + gsid.String()
}

// claimScript atomically enforces the per-user device limit and binds the gateway session to
// its (auth session, tab). Returns false when the device limit is reached, else an array:
// [1] the replaced gateway session of the same tab ("" if none), [2..] the evicted ones.
var claimScript = rueidis.NewLuaScript(`
local zkey, tkey = KEYS[1], KEYS[2]
local now, expiry, max, asess, gsid, ttl, tab, cap = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4], ARGV[5], tonumber(ARGV[6]), ARGV[7], tonumber(ARGV[8])
redis.call('ZREMRANGEBYSCORE', zkey, '-inf', now)
local same = redis.call('ZSCORE', zkey, asess)
if not same and redis.call('ZCARD', zkey) >= max then return false end
redis.call('ZADD', zkey, expiry, asess)
redis.call('EXPIRE', zkey, ttl)
local prefix = tab .. '|'
local mine = prefix .. gsid
local out = {''}
for _, m in ipairs(redis.call('ZRANGE', tkey, 0, -1)) do
  if string.sub(m, 1, #prefix) == prefix then
    redis.call('ZREM', tkey, m)
    local g = string.sub(m, #prefix + 1)
    if g ~= gsid then out[1] = g end
  end
end
redis.call('ZADD', tkey, now, mine)
local n = redis.call('ZCARD', tkey)
if n > cap then
  for _, m in ipairs(redis.call('ZRANGE', tkey, 0, -1)) do
    if n <= cap then break end
    if m ~= mine then
      redis.call('ZREM', tkey, m)
      n = n - 1
      local p = string.find(m, '|', 1, true)
      if p then table.insert(out, string.sub(m, p + 1)) end
    end
  end
end
redis.call('EXPIRE', tkey, ttl)
return out`)

// forgetScript unbinds a destroyed gateway session; the device leaves the per-user limit once
// its last tab is gone (a newer session of the same tab has another member and is kept).
var forgetScript = rueidis.NewLuaScript(`
if redis.call('ZREM', KEYS[2], ARGV[1]) == 1 and redis.call('ZCARD', KEYS[2]) == 0 then
  redis.call('DEL', KEYS[2])
  redis.call('ZREM', KEYS[1], ARGV[2])
end
return 1`)

// claimDevice enforces the per-user device limit and the per-auth-session tab cap (see the
// file comment). A new IDENTIFY of the same tab replaces its previous gateway session.
func (h *Hub) claimDevice(ctx context.Context, user, asess, gsid uuid.UUID, tab string) (bool, error) {
	ttl := 2*h.cfg.HeartbeatInterval + resumeWindow
	res := claimScript.Exec(ctx, h.redis, []string{deviceKey(user), tabsKey(asess)}, []string{
		strconv.FormatInt(time.Now().UnixMilli(), 10), strconv.FormatInt(int64(expiryScore(ttl)), 10),
		strconv.Itoa(h.cfg.MaxSessionsPerUser), asess.String(), gsid.String(), strconv.Itoa(int(ttl.Seconds())),
		tab, strconv.Itoa(h.cfg.MaxTabsPerSession),
	})
	out, err := res.AsStrSlice()
	if rueidis.IsRedisNil(err) {
		return false, nil // limit reached (Lua false → nil)
	}
	if err != nil {
		return false, err
	}
	for i, g := range out {
		if g != "" {
			h.kill(ctx, parseID(g), i > 0)
		}
	}
	return true, nil
}

// reclaimTab marks a resumed session as the most recently claimed tab of its auth session
// (only if it is still bound: an evicted one is not brought back).
func (h *Hub) reclaimTab(ctx context.Context, s *Session) {
	_ = h.redis.Do(ctx, h.redis.B().Zadd().Key(tabsKey(s.asess)).Xx().ScoreMember().
		ScoreMember(float64(time.Now().UnixMilli()), tabMember(s.tab, s.id)).Build()).Error()
}

// killClose is the close of a session ended by another one of its auth session.
func killClose(evicted bool) (int, string) {
	if evicted {
		return 4011, "evicted by a newer tab"
	}
	return 4000, "replaced by a new session"
}

// kill destroys a gateway session wherever it lives: replaced by the same tab, or evicted.
func (h *Hub) kill(ctx context.Context, gsid uuid.UUID, evicted bool) {
	h.mu.RLock()
	s := h.sessions[gsid]
	h.mu.RUnlock()
	if s != nil {
		code, why := killClose(evicted)
		go h.destroy(s, code, why) //nolint:gosec // G118: teardown must outlive the request
		return
	}
	if m, ok, err := h.buf.meta(ctx, gsid); err == nil && ok && m.owner != "" {
		cmd := "kill "
		if evicted {
			cmd = "evict "
		}
		h.sendControl(ctx, m.owner, cmd+gsid.String())
	}
	h.buf.drop(ctx, gsid)
}

func (h *Hub) forgetDevice(ctx context.Context, s *Session) {
	_ = forgetScript.Exec(ctx, h.redis, []string{deviceKey(s.user), tabsKey(s.asess)}, []string{tabMember(s.tab, s.id), s.asess.String()}).Error()
}
