//go:build integration

package app_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/redisx"
)

// With REDIS_KEY_PREFIX the API keeps to its namespace in pub/sub too (docs/06 «Общий Valkey»):
// the gateway ignores an event on the channel without the prefix (another application's) and
// delivers it on the namespaced one, and a plan change reaches another instance over the
// namespaced channel. The instances' control channels are covered by TestResumeAcrossInstances,
// session revocation by the gateway tests; that no key escapes the namespace is checked for the
// whole run in TestMain.
func TestRedisNamespace(t *testing.T) {
	if redisx.KeyPrefix() == "" {
		t.Skip("no key namespace in this run (TEST_REDIS_KEY_PREFIX is empty)")
	}
	ctx := context.Background()
	_, bob, ws, _ := setupTeam(t)
	wid := uuid.MustParse(ws.GetId())
	g := dialGW(t)
	g.identify(bob.token)

	publish := func(channel, name string) error {
		b, err := events.Encode(&v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceUpdate{
			WorkspaceUpdate: &v1.WorkspaceUpdate{Workspace: &v1.Workspace{Id: ws.GetId(), Name: name}},
		}})
		if err != nil {
			return err
		}
		return testRedis.Do(ctx, testRedis.B().Publish().Channel(channel).Message(rueidis.BinaryString(b)).Build()).Error()
	}
	// As another application would, without the namespace (an ACL user limited to the namespace
	// may not even publish there: NOPERM). In this order over one connection, a delivered
	// foreign event would arrive first.
	if err := publish(events.WorkspacePrefix+ws.GetId(), "outside"); err != nil && !strings.Contains(err.Error(), "NOPERM") {
		t.Fatal(err)
	}
	if err := publish(events.WorkspaceChannel(wid), "inside"); err != nil {
		t.Fatal(err)
	}
	got := g.wait("WORKSPACE_UPDATE", func(e *v1.DispatchEvent) bool {
		n := e.GetWorkspaceUpdate().GetWorkspace().GetName()
		return n == "outside" || n == "inside"
	})
	if n := got.GetWorkspaceUpdate().GetWorkspace().GetName(); n != "inside" {
		t.Fatal("the gateway delivered an event published outside the namespace")
	}

	// Plans: another instance caches the plan and drops it on <prefix>plans:changed.
	b := newInstance(t)
	if info, err := b.app.Plans.Info(ctx, wid); err != nil || info.Plan != v1.Plan_PLAN_FREE {
		t.Fatalf("plan before: %v %v", info.Plan, err)
	}
	if _, err := testDB.Pool.Exec(ctx, "INSERT INTO workspace_plans (workspace_id, plan) VALUES ($1, 'team')", wid); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(5 * time.Second); ; { // well below plans.CacheTTL
		testApp.Plans.Invalidate(ctx, wid) // again each round: b may still be subscribing
		if info, err := b.app.Plans.Info(ctx, wid); err == nil && info.Plan == v1.Plan_PLAN_TEAM {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the plan change did not reach the other instance")
		}
		time.Sleep(100 * time.Millisecond)
	}
}
