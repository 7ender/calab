//go:build integration

package guests

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/google/uuid"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

// Room links in an enforced workspace: refused as public capabilities, admitted for a
// caller whose session holds a current SSO assurance (the assured check), never without it.
func TestRoomLinkCapabilityHonoursSSOAssurance(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	owner, ws := uuid.New(), uuid.New()
	if _, err := d.Pool.Exec(ctx, `INSERT INTO users(id,email,display_name)VALUES($1,$2,'Owner')`, owner, owner.String()+"@guests.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Pool.Exec(ctx, `INSERT INTO workspaces(id,slug,name,owner_id)VALUES($1,$2,'Links',$3)`, ws, "lnk-"+ws.String()[:12], owner); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = d.Pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id=$1`, ws)
		_, _ = d.Pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, owner)
	})
	ok := func(context.Context) error { return nil }
	denied := errors.New("no assurance")
	refuse := func(context.Context) error { return denied }
	// Off: a public capability; the assured check is not consulted.
	if err := linkCapability(ctx, d.Q, ws, refuse); err != nil {
		t.Fatalf("off: %v", err)
	}
	if _, err := d.Pool.Exec(ctx, `INSERT INTO workspace_identity_policies(workspace_id,mode)VALUES($1,'enforced')`, ws); err != nil {
		t.Fatal(err)
	}
	var coded *httpx.Error
	if err := linkCapability(ctx, d.Q, ws, nil); !errors.As(err, &coded) || coded.Status != 403 {
		t.Fatalf("enforced, account-less: %v", err)
	}
	if err := linkCapability(ctx, d.Q, ws, refuse); !errors.Is(err, denied) {
		t.Fatalf("enforced, no assurance: %v", err)
	}
	if err := linkCapability(ctx, d.Q, ws, ok); err != nil {
		t.Fatalf("enforced, assured member: %v", err)
	}
}
