//go:build integration

package app_test

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/redisx"
)

// Several integration runs of this package may share one dev Redis (teammates, `go test ./...`
// next to a focused run). Everything the app keeps in Redis — rate-limit buckets keyed by the
// tests' fixed X-Forwarded-For addresses (rl:auth:login:10.77.0.1 …), voice state, gateway
// buffers — lives in one logical DB, and every run starts with FLUSHDB. Two runs on the same DB
// therefore drain each other's limiter buckets (spurious 429 in TestWebCookieAuth,
// TestLoginRateLimitAndBadCredentials, TestChangeCredentials, TestGuests) and wipe each other's
// voice state mid-test. Each run leases its own logical DB instead.
//
// Leases are keys in DB 0 (calaba:it:db:<n>, value = run token) with a TTL that a heartbeat
// extends, so a crashed run frees its DB within leaseTTL. Pub/sub is not DB-scoped, but every
// channel the app uses is keyed by random ids (workspace/user/session/instance), so concurrent
// runs ignore each other's messages.

const (
	leaseTTL   = 2 * time.Minute
	leaseEvery = 30 * time.Second
	leaseWait  = 10 * time.Minute // a whole run of the package takes ~1.5 min

	// leaseKeyPrefix names the lease keys (DB 0): harness keys, outside the app's namespace.
	leaseKeyPrefix = "calaba:it:db:"
)

// leaseCandidates: the DB of TEST_REDIS_URL first (15 by default, as before), then 15..1
// except 0 (the dev server's DB) and TEST_RTC_REDIS_DB (internal/rtc's tests, default 14).
func leaseCandidates(preferred, rtcDB int) []int {
	out := []int{preferred}
	for n := 15; n >= 1; n-- {
		if n != preferred && n != rtcDB {
			out = append(out, n)
		}
	}
	return out
}

// dbInUse reports whether a client other than lc (DB 0) is connected to logical DB n: a run
// that does not lease (a binary built before leasing, another checkout with its own harness)
// must not be flushed under its feet.
func dbInUse(ctx context.Context, lc rueidis.Client, n int) (bool, error) {
	list, err := lc.Do(ctx, lc.B().ClientList().Build()).ToString()
	if err != nil {
		return false, err
	}
	want := "db=" + strconv.Itoa(n)
	for _, line := range strings.Split(list, "\n") {
		for _, f := range strings.Fields(line) {
			if f == want {
				return true, nil
			}
		}
	}
	return false, nil
}

// leaseRedisDB returns TEST_REDIS_URL rewritten to a logical DB leased for this process and a
// release func. The DB is flushed by the caller (it owns it now).
func leaseRedisDB(ctx context.Context, base string) (string, func(), error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", nil, fmt.Errorf("TEST_REDIS_URL: %w", err)
	}
	rtcDB, err := strconv.Atoi(env("TEST_RTC_REDIS_DB", "14"))
	if err != nil {
		return "", nil, fmt.Errorf("TEST_RTC_REDIS_DB: %w", err)
	}
	preferred := 15
	if p := strings.Trim(u.Path, "/"); p != "" {
		if preferred, err = strconv.Atoi(p); err != nil {
			return "", nil, fmt.Errorf("TEST_REDIS_URL db %q: %w", p, err)
		}
	}
	lu := *u
	lu.Path = "/0"
	opt, err := rueidis.ParseURL(lu.String())
	if err != nil {
		return "", nil, err
	}
	lc, err := rueidis.NewClient(opt)
	if err != nil {
		return "", nil, err
	}
	token := uuid.NewString()
	key := func(n int) string { return leaseKeyPrefix + strconv.Itoa(n) }

	deadline := time.Now().Add(leaseWait)
	for {
		for _, n := range leaseCandidates(preferred, rtcDB) {
			ok, err := lc.Do(ctx, lc.B().Set().Key(key(n)).Value(token).Nx().Ex(leaseTTL).Build()).AsBool()
			if rueidis.IsRedisNil(err) {
				continue // held by another run
			}
			if err != nil {
				lc.Close()
				return "", nil, fmt.Errorf("lease redis db: %w", err)
			}
			if !ok {
				continue
			}
			if busy, err := dbInUse(ctx, lc, n); err != nil || busy {
				_ = lc.Do(ctx, lc.B().Del().Key(key(n)).Build()).Error()
				if busy {
					fmt.Fprintf(os.Stderr, "integration: redis db %d is used by a client that holds no lease — skipping it\n", n)
				}
				continue
			}
			// heartbeat: keep the lease while the run lasts (not tied to ctx's cancellation)
			hb, stopHB := context.WithCancel(context.WithoutCancel(ctx))
			done := make(chan struct{})
			go func() {
				defer close(done)
				t := time.NewTicker(leaseEvery)
				defer t.Stop()
				for {
					select {
					case <-hb.Done():
						return
					case <-t.C:
						_ = lc.Do(hb, lc.B().Set().Key(key(n)).Value(token).Xx().Ex(leaseTTL).Build()).Error()
					}
				}
			}()
			release := func() {
				stopHB()
				<-done
				rctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				if v, err := lc.Do(rctx, lc.B().Get().Key(key(n)).Build()).ToString(); err == nil && v == token {
					_ = lc.Do(rctx, lc.B().Del().Key(key(n)).Build()).Error()
				}
				lc.Close()
			}
			du := *u
			du.Path = "/" + strconv.Itoa(n)
			return du.String(), release, nil
		}
		if time.Now().After(deadline) {
			lc.Close()
			return "", nil, fmt.Errorf("no free redis db for the integration run after %s", leaseWait)
		}
		time.Sleep(time.Second)
	}
}

// holdReconcileLock keeps the background voice reconcile (app.Run: every 30 s) from running
// during the tests. The tests create rooms in the real dev LiveKit but simulate participants
// and tracks with webhooks, so a reconcile tick sees those rooms empty and removes the
// simulated screen shares at once (reconcileStreams has no grace window) — TestRTC's
// "stop-stream → 404" flake whenever a tick landed mid-test. Tests that exercise Reconcile
// run it through runReconcile, which pauses the holder for the call.
func holdReconcileLock(ctx context.Context, c rueidis.Client) {
	hold := func() {
		reconcileHold.Lock()
		defer reconcileHold.Unlock()
		_ = c.Do(context.Background(), c.B().Set().Key(redisx.Key("rtc:reconcile")).Value("integration-tests").Ex(time.Minute).Build()).Error()
	}
	hold()
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				hold()
			}
		}
	}()
}

// reconcileHold serializes the lock holder with explicit Reconcile calls.
var reconcileHold sync.Mutex

// runReconcile runs one reconcile pass now: frees the lock (the holder cannot retake it
// meanwhile) and calls Reconcile, which takes and keeps it; the holder resumes afterwards.
func runReconcile(t *testing.T) {
	t.Helper()
	reconcileHold.Lock()
	defer reconcileHold.Unlock()
	_ = testRedis.Do(context.Background(), testRedis.B().Del().Key(redisx.Key("rtc:reconcile")).Build()).Error()
	if err := testApp.RTC.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
}
