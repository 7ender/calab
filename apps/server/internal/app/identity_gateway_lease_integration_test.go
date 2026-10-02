//go:build integration

package app_test

import (
	"context"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/google/uuid"
)

// The expiry is authoritative DB state and no invalidation is published. A second
// independently proved session of the same user must retain A and ordinary local B.
func TestIdentityGatewayLeaseLostPubsubDeadline(t *testing.T) {
	f := identitySetup(t, "enforced")
	f.prove(t, uuid.MustParse(f.local.session), time.Now())
	f.prove(t, f.scopedSession.ID, time.Now().Add(-time.Hour+2*time.Second))
	scoped, local := dialGW(t), dialGW(t)
	defer func() { _ = scoped.ws.CloseNow(); _ = local.ws.CloseNow() }()
	sr, lr := scoped.identify(f.scoped.token), local.identify(f.local.token)
	if len(sr.Workspaces) != 1 || len(lr.Workspaces) != 2 {
		t.Fatal("leases were not warmed for each exact device")
	}
	before := send(t, f.local, f.roomA, "before short proof deadline", "")
	scoped.wait("warm scoped lease", func(e *v1.DispatchEvent) bool { return e.GetMessageCreate().GetMessage().GetId() == before.Id })
	if _, err := testDB.Q.RevokeWorkspaceAssurances(context.Background(), sqlc.RevokeWorkspaceAssurancesParams{WorkspaceID: uuid.MustParse(f.a.Id), SessionID: &f.scopedSession.ID}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2300 * time.Millisecond)
	after := send(t, f.local, f.roomA, "after lost-pubsub deadline", "")
	local.wait("independent proof survives", func(e *v1.DispatchEvent) bool { return e.GetMessageCreate().GetMessage().GetId() == after.Id })
	scoped.quiet("expired scoped proof payload", 300*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetMessageCreate().GetMessage().GetId() == after.Id })
	b := send(t, f.local, f.roomB, "ordinary local SSO-off B", "")
	local.wait("unrelated workspace live", func(e *v1.DispatchEvent) bool { return e.GetMessageCreate().GetMessage().GetId() == b.Id })
}

func TestIdentityGatewayLeaseUserScopeAndOrdinaryDM(t *testing.T) {
	f := identitySetup(t, "optional")
	scoped, local := dialGW(t), dialGW(t)
	defer func() { _ = scoped.ws.CloseNow(); _ = local.ws.CloseNow() }()
	scoped.identify(f.scoped.token)
	local.identify(f.local.token)
	o := owner(t)
	var created v1.CreateDmResponse
	f.local.must(201, "POST", "/api/dms", &v1.CreateDmRequest{UserId: o.id}, &created)
	dm := created.Dm.GetRoom().GetId()
	local.wait("local DM create", func(e *v1.DispatchEvent) bool { return e.GetDmCreate().GetDm().GetRoom().GetId() == dm })
	message := send(t, f.local, dm, "local DM authority", "")
	local.wait("ordinary local DM fanout", func(e *v1.DispatchEvent) bool { return e.GetMessageCreate().GetMessage().GetId() == message.Id })
	scoped.quiet("scoped DM disclosure", 250*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetDmCreate() != nil || e.GetMessageCreate().GetMessage().GetRoomId() == dm
	})
	event := &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{MessageCreate: &v1.MessageCreate{Message: &v1.Message{Id: uuid.NewString(), RoomId: f.roomB, Content: "resolved B authority"}}}}
	(events.Redis{C: testRedis}).User(context.Background(), uuid.MustParse(f.local.id), event)
	local.wait("once-resolved B event", func(e *v1.DispatchEvent) bool {
		return e.GetMessageCreate().GetMessage().GetContent() == "resolved B authority"
	})
	scoped.quiet("cross-workspace user channel", 250*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetMessageCreate().GetMessage().GetContent() == "resolved B authority"
	})
	// A recognized event with no resource attribution is not implicitly global.
	(events.Redis{C: testRedis}).User(context.Background(), uuid.MustParse(f.local.id), &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageDelete{MessageDelete: &v1.MessageDelete{MessageId: uuid.NewString()}}})
	local.quiet("unattributed content event", 200*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetMessageDelete() != nil })
}
