//go:build integration

package directory

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/sso"
)

// An operator LDAPS host bound to other workspaces (IDENTITY_DIRECTORY_HOSTS workspace_ids) is
// neither configurable nor scanned for this workspace; bound to it, both work.
func TestDirectoryHostBoundToWorkspaces(t *testing.T) {
	f := newDirectoryFixture(t)
	ctx := context.Background()
	client := f.service.LDAP.(*LDAP)
	bind := func(ws uuid.UUID) {
		p := client.Hosts["127.0.0.1"]
		p.Workspaces = map[uuid.UUID]bool{ws: true}
		client.Hosts["127.0.0.1"] = p
	}
	c, err := f.service.Identity.DB.Q.GetWorkspaceIdentityDirectory(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	put := func() error {
		_, err := f.service.Put(ctx, f.p, f.ws, &pb.PutIdentityDirectoryRequest{Version: uint64(max(c.Version, 0)), Enabled: true, Url: c.Url, BaseDn: c.BaseDn, BindDn: c.BindDn, AllowedGroupDns: c.AllowedGroupDns})
		return err
	}
	bind(f.otherWS)
	if err := f.service.Sync(ctx, f.ws); err == nil {
		t.Fatal("host bound to another workspace was scanned")
	}
	if err := put(); !errors.Is(err, sso.ErrInvalid) {
		t.Fatalf("host bound to another workspace configured: %v", err)
	}
	bind(f.ws)
	f.sync(t)
	if err := put(); err != nil {
		t.Fatalf("bound workspace: %v", err)
	}
}
