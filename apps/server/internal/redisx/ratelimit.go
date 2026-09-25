package redisx

import (
	"context"
	"strconv"

	"github.com/redis/rueidis"
)

// Token bucket in a Redis hash {t: tokens, ts: last refill ms}. Uses the Redis clock, so
// all API instances share one bucket per key. Returns 1 if the request is allowed.
var tokenBucket = rueidis.NewLuaScript(`
local key = KEYS[1]
local burst = tonumber(ARGV[1])
local rate = tonumber(ARGV[2]) -- tokens per ms
local now_parts = redis.call('TIME')
local now = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)
local b = redis.call('HMGET', key, 't', 'ts')
local tokens = tonumber(b[1])
local ts = tonumber(b[2])
if tokens == nil then tokens = burst; ts = now end
tokens = math.min(burst, tokens + (now - ts) * rate)
local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
redis.call('HSET', key, 't', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', key, math.ceil(burst / rate) + 1000)
return allowed
`)

// RateLimiter is a Redis-backed token bucket limiter.
type RateLimiter struct {
	c      rueidis.Client
	prefix string
	burst  int
	perMs  float64
}

// NewRateLimiter allows `burst` requests at once, refilled at perMinute tokens/minute.
func NewRateLimiter(c rueidis.Client, prefix string, burst int, perMinute float64) *RateLimiter {
	return &RateLimiter{c: c, prefix: prefix, burst: burst, perMs: perMinute / 60000}
}

// Allow takes one token for key. Redis errors are returned (callers decide fail-open/closed).
func (l *RateLimiter) Allow(ctx context.Context, key string) (bool, error) {
	n, err := tokenBucket.Exec(ctx, l.c, []string{l.prefix + key},
		[]string{strconv.Itoa(l.burst), strconv.FormatFloat(l.perMs, 'g', -1, 64)}).AsInt64()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}
