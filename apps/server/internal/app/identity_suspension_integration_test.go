//go:build integration

package app_test

import (
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/google/uuid"
	"testing"
	"time"
)

func TestIdentitySuspensionLocalReadIsolation(t *testing.T) {
	for _, mode := range []string{"off", "optional"} {
		t.Run(mode, func(t *testing.T) {
			f := identitySetup(t, mode)
			send(t, f.local, f.roomA, "History survives suspension", "")
			// Prove a private room's ACL remains independent of the read-only exception.
			var hidden v1.CreateRoomResponse
			owner(t).must(201, "POST", "/api/workspaces/"+f.a.Id+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "Hidden", IsPrivate: true}, &hidden)
			suspend(t, f.a.Id, true, "Read-only fixture")
			// Suspension revokes an already issued scoped session. Also construct a
			// live scoped fixture with fresh proof to test the suspension gate itself.
			f.scoped.must(401, "GET", "/api/workspaces/"+f.a.Id, nil, nil)
			f.scoped = compatibilityAuthority(t, f.local, "workspace_sso", uuid.MustParse(f.a.Id), &f.connection.ID)
			f.prove(t, uuid.MustParse(f.scoped.session), time.Now())
			for _, path := range []string{"/api/workspaces/" + f.a.Id, "/api/workspaces/" + f.a.Id + "/members", "/api/rooms/" + f.roomA + "/messages"} {
				f.local.must(200, "GET", path, nil, nil)
				f.scoped.must(403, "GET", path, nil, nil)
			}
			recovery := compatibilityAuthority(t, f.local, "recovery", uuid.MustParse(f.a.Id), nil)
			recovery.must(403, "GET", "/api/rooms/"+f.roomA+"/messages", nil, nil)
			f.local.must(404, "GET", "/api/rooms/"+hidden.Room.Id+"/messages", nil, nil)
			f.local.wantErr(403, errSuspended, "POST", "/api/rooms/"+f.roomA+"/messages", &v1.CreateMessageRequest{Content: "Denied write"})
			f.local.wantErr(403, errSuspended, "POST", "/api/rooms/"+f.roomA+"/join", nil)
			local := dialGW(t)
			defer func() { _ = local.ws.CloseNow() }()
			ready := local.identify(f.local.token)
			found := false
			for _, snap := range ready.Workspaces {
				if snap.Workspace.Id == f.a.Id {
					found = true
					for _, room := range snap.Rooms {
						if room.Id == hidden.Room.Id {
							t.Fatal("READY disclosed hidden room")
						}
					}
				}
			}
			if !found {
				t.Fatal("suspended local receive-only READY lost workspace")
			}
			scoped := dialGW(t)
			defer func() { _ = scoped.ws.CloseNow() }()
			for _, snap := range scoped.identify(f.scoped.token).Workspaces {
				if snap.Workspace.Id == f.a.Id {
					t.Fatal("scoped suspended workspace in READY")
				}
			}
			watcher := dialGW(t)
			defer func() { _ = watcher.ws.CloseNow() }()
			watcher.identify(owner(t).token)
			watcher.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_SUBSCRIBE, Payload: &v1.GatewayFrame_Subscribe{Subscribe: &v1.Subscribe{RoomIds: []string{f.roomA}}}})
			time.Sleep(50 * time.Millisecond)
			local.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_TYPING, Payload: &v1.GatewayFrame_Typing{Typing: &v1.Typing{RoomId: f.roomA}}})
			watcher.quiet("receive lease must not publish typing", 150*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetTypingStart().GetUserId() == f.local.id })
			// A fresh corporate proof does not create an enforced suspension exception.
			identityReferencePolicy(t, f.a.Id, "enforced")
			f.prove(t, uuid.MustParse(f.local.session), time.Now())
			f.local.wantErr(403, errSuspended, "GET", "/api/rooms/"+f.roomA+"/messages", nil)
			identityReferencePolicy(t, f.a.Id, mode)
			// Managed membership cannot turn off its directory check by reading while suspended.
			ws, uid := uuid.MustParse(f.a.Id), uuid.MustParse(f.local.id)
			dir, err := testDB.Q.CreateIdentityDirectory(t.Context(), sqlc.CreateIdentityDirectoryParams{WorkspaceID: ws, Name: "Suspension fixture", Host: "directory.identity.test", Url: "ldaps://directory.identity.test:636", Port: 636, AllowedGroupDns: []string{"CN=allowed,DC=identity,DC=test"}, BaseDn: "DC=identity,DC=test", BindDn: "CN=fixture,DC=identity,DC=test", BindSecretBox: []byte("fixture-only"), SyncIntervalSeconds: 300, MaxStalenessSeconds: 3600})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := testDB.Q.CreateDirectoryObject(t.Context(), sqlc.CreateDirectoryObjectParams{WorkspaceID: ws, DirectoryID: dir.ID, ObjectGuid: uuid.New(), UserID: &uid, DistinguishedName: "CN=member,DC=identity,DC=test", Status: "active"}); err != nil {
				t.Fatal(err)
			}
			if _, err := testDB.Pool.Exec(t.Context(), "UPDATE workspace_directories SET last_success_at=now(), disabled_at=now() WHERE id=$1", dir.ID); err != nil {
				t.Fatal(err)
			}
			f.local.wantErr(403, v1.ErrorCode_ERROR_CODE_DIRECTORY_ACCESS_DENIED, "GET", "/api/rooms/"+f.roomA+"/messages", nil)
			if _, err := testDB.Pool.Exec(t.Context(), "UPDATE workspace_directories SET disabled_at=NULL,last_success_at=now()-interval '2 hours' WHERE id=$1", dir.ID); err != nil {
				t.Fatal(err)
			}
			f.local.wantErr(403, v1.ErrorCode_ERROR_CODE_DIRECTORY_ACCESS_DENIED, "GET", "/api/rooms/"+f.roomA+"/messages", nil)
			denied := dialGW(t)
			defer func() { _ = denied.ws.CloseNow() }()
			for _, snap := range denied.identify(f.local.token).Workspaces {
				if snap.Workspace.Id == f.a.Id {
					t.Fatal("stale directory skipped by READY read exception")
				}
			}
		})
	}
}
