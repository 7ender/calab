package pbconv

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

func TestWorkspaceSuspensionForViewer(t *testing.T) {
	at := time.Now()
	ws := Workspace(sqlc.Workspace{ID: uuid.New(), SuspendedAt: &at, SuspendedReason: "unpaid"})
	if ws.GetSuspension().GetReason() != "unpaid" || !ws.GetSuspension().GetAt().AsTime().Equal(at) {
		t.Fatalf("suspension: %v", ws.GetSuspension())
	}
	for _, role := range []perm.Role{perm.RoleOwner, perm.RoleAdmin} {
		if ForViewer(ws, role) != ws {
			t.Fatalf("%s: copied / hidden", role)
		}
	}
	for _, role := range []perm.Role{perm.RoleMember, perm.RoleGuest, ""} {
		v := ForViewer(ws, role)
		if v.GetSuspension() == nil || v.GetSuspension().GetReason() != "" {
			t.Fatalf("%s sees %v", role, v.GetSuspension())
		}
	}
	if ws.GetSuspension().GetReason() != "unpaid" {
		t.Fatal("ForViewer modified its argument")
	}
	if active := Workspace(sqlc.Workspace{ID: uuid.New()}); active.GetSuspension() != nil || ForViewer(active, "") != active {
		t.Fatal("an active workspace has a suspension")
	}
}
