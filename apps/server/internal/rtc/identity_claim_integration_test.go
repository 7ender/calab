//go:build integration

package rtc

import (
	"context"
	"testing"
	"time"
)

// One replica sweeps per period; a wake claims separately (a periodic claim never
// delays a revocation sweep), and claims expire on their own.
func TestIdentitySweepClusterClaim(t *testing.T) {
	a, rc := testService(t, &fakeLK{})
	b := &Service{redis: rc}
	ctx := context.Background()
	if !a.claimIdentitySweep(ctx, "rtc:identity:sweep", 200*time.Millisecond) {
		t.Fatal("first replica did not claim the sweep")
	}
	if b.claimIdentitySweep(ctx, "rtc:identity:sweep", 200*time.Millisecond) {
		t.Fatal("second replica swept in the same period")
	}
	if !b.claimIdentitySweep(ctx, "rtc:identity:wake", 200*time.Millisecond) {
		t.Fatal("a periodic claim blocked the wake sweep")
	}
	if a.claimIdentitySweep(ctx, "rtc:identity:wake", 200*time.Millisecond) {
		t.Fatal("two replicas swept for one wake")
	}
	time.Sleep(300 * time.Millisecond)
	if !b.claimIdentitySweep(ctx, "rtc:identity:sweep", 200*time.Millisecond) {
		t.Fatal("expired claim was not released")
	}
	if !(&Service{}).claimIdentitySweep(ctx, "rtc:identity:sweep", time.Second) {
		t.Fatal("without Valkey the replica must sweep itself")
	}
}
