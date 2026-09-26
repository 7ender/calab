//go:build integration

package app_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/events"
)

// An event published with the context of a request whose client already went away (reload
// right after a POST) is still delivered: the change is committed, the others must see it.
func TestEventSurvivesCanceledRequest(t *testing.T) {
	_, bob, ws, _ := setupTeam(t)
	g := dialGW(t)
	g.identify(bob.token)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	events.Redis{C: testRedis}.Workspace(ctx, uuid.MustParse(ws.GetId()), &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceUpdate{
		WorkspaceUpdate: &v1.WorkspaceUpdate{Workspace: &v1.Workspace{Id: ws.GetId(), Name: "published after cancel"}},
	}})
	g.wait("WORKSPACE_UPDATE published with a canceled context", func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceUpdate().GetWorkspace().GetName() == "published after cancel"
	})
}
