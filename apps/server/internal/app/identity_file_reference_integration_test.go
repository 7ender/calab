//go:build integration

package app_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/google/uuid"
)

func identityReferenceFile(t *testing.T, u *user, workspace string) sqlc.File {
	t.Helper()
	status, meta, _ := upload(t, u, "/api/workspaces/"+workspace+"/files", "reference.png", pngBytes(16, 16))
	if status != http.StatusCreated || meta == nil {
		t.Fatalf("upload reference: HTTP %d", status)
	}
	file, err := testDB.Q.GetFile(t.Context(), uuid.MustParse(meta.Id))
	if err != nil {
		t.Fatal(err)
	}
	return file
}

func identityReferenceMessage(t *testing.T, u *user, room string, file sqlc.File) *v1.Message {
	t.Helper()
	var response v1.CreateMessageResponse
	u.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{file.ID.String()}, Nonce: uniq("identity-ref-")}, &response)
	return response.Message
}

func identityReferencePolicy(t *testing.T, workspace, mode string) {
	t.Helper()
	ws := uuid.MustParse(workspace)
	policy, err := testDB.Q.EnsureIdentityPolicy(t.Context(), ws)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := testDB.Q.SetIdentityPolicy(t.Context(), sqlc.SetIdentityPolicyParams{WorkspaceID: ws, Mode: mode, AssuranceMaxAgeSeconds: 3600, ExpectedVersion: policy.Version}); err != nil {
		t.Fatal(err)
	}
}

// Authenticate and resolve the durable principal, then install the same identity
// and permission contexts as the App. This exercises the real typed file handler
// while the separately owned App routing change is pending.
func identityReferenceRequest(ctx context.Context, t *testing.T, u *user, method string) *http.Request {
	t.Helper()
	r, err := http.NewRequestWithContext(ctx, method, srv.URL+"/api/files/"+uuid.NewString(), http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", "Bearer "+u.token)
	id, err := testApp.Auth.Authenticate(r)
	if err != nil {
		t.Fatal(err)
	}
	id.Principal, err = testApp.Auth.ResolvePrincipal(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	ctx = auth.WithIdentity(ctx, id)
	ctx = perm.WithResolver(ctx, testDB.Q)
	ctx = testApp.Auth.WithPolicy(ctx, id, identitypolicy.WorkspaceRead)
	return r.WithContext(ctx)
}

func identityReferenceRead(t *testing.T, u *user, file sqlc.File, want bool) {
	t.Helper()
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		r := identityReferenceRequest(t.Context(), t, u, method)
		allowed, err := testApp.Files.CanRead(r, file)
		if allowed != want || want && err != nil {
			t.Fatalf("CanRead %s authority session=%s file=%s: allowed=%v err=%v want=%v", method, u.session, file.ID, allowed, err, want)
		}
		if !want && err != nil && httpx.AsError(err).Status >= 500 {
			t.Fatalf("expected access denial, got dependency failure: %v", err)
		}
	}
}

func identityReferenceRecovery(t *testing.T, f identityFixture) *user {
	t.Helper()
	ws, now := uuid.MustParse(f.a.Id), time.Now()
	_, hash, err := auth.NewRefreshSecret()
	if err != nil {
		t.Fatal(err)
	}
	session, err := testDB.Q.CreateScopedIdentitySession(t.Context(), sqlc.CreateScopedIdentitySessionParams{UserID: uuid.MustParse(f.local.id), RefreshTokenHash: hash, ExpiresAt: now.Add(10 * time.Minute), AuthorityKind: "recovery", AuthorityWorkspaceID: &ws, RecoveryAuthenticatedAt: &now})
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := testApp.Auth.Tokens().Issue(session.UserID, session.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	return &user{client: &client{t: t, token: token}, id: f.local.id, session: session.ID.String()}
}

func TestIdentityFileReferencesCanRead(t *testing.T) {
	f := identitySetup(t, "optional")
	aFile := identityReferenceFile(t, owner(t), f.a.Id)
	original := identityReferenceMessage(t, owner(t), f.roomA, aFile)
	copyB := forwardMsg(t, f.local, f.roomA, original.Id, f.roomB, 201)
	dm := openDM(t, f.local, owner(t).id, 201).Room.Id
	copyDM := forwardMsg(t, f.local, f.roomA, original.Id, dm, 201)
	stranger := register(t, invite(t, owner(t), f.b.Id))
	identityReferenceRead(t, stranger, aFile, true) // no membership in the origin

	bFile := identityReferenceFile(t, f.local, f.b.Id)
	bOriginal := identityReferenceMessage(t, f.local, f.roomB, bFile)
	identityReferenceRead(t, f.scoped, bFile, false) // uploader does not bypass B scope
	copyA := forwardMsg(t, f.local, f.roomB, bOriginal.Id, f.roomA, 201)
	identityReferenceRead(t, f.scoped, bFile, true) // B denial must not hide A's copy

	identityReferencePolicy(t, f.a.Id, "enforced")
	f.prove(t, f.scopedSession.ID, time.Now())
	identityReferenceRead(t, f.local, aFile, true) // denied A reference, allowed B/DM
	identityReferenceRead(t, f.scoped, aFile, true)
	identityReferenceRead(t, f.scoped, bFile, true)
	identityReferenceRead(t, identityReferenceRecovery(t, f), aFile, false)

	if _, err := testDB.Q.SoftDeleteMessage(t.Context(), uuid.MustParse(original.Id)); err != nil {
		t.Fatal(err)
	}
	identityReferenceRead(t, f.scoped, aFile, false) // B/DM cannot replace A's deleted copy
	f.scoped.must(204, "DELETE", "/api/messages/"+copyA.Id, nil, nil)
	identityReferenceRead(t, f.scoped, bFile, false)
	f.local.must(204, "DELETE", "/api/messages/"+copyB.Id, nil, nil)
	identityReferenceRead(t, stranger, aFile, false) // last accessible reference deleted
	identityReferenceRead(t, f.local, aFile, true)   // ordinary local DM forwarding preserved

	// B's enforcement is independent of A. Without a B proof its live copy does
	// not authorize reading, even though the same account has an A assurance.
	identityReferencePolicy(t, f.b.Id, "enforced")
	identityReferenceRead(t, f.local, bFile, false)
	identityReferencePolicy(t, f.b.Id, "off")
	f.local.must(204, "DELETE", "/api/messages/"+copyDM.Id, nil, nil)
	identityReferenceRead(t, f.local, aFile, false) // no accessible live reference remains
}

func TestIdentityFileReferencesStickerCanRead(t *testing.T) {
	f := identitySetup(t, "optional")
	file := identityReferenceFile(t, f.local, f.b.Id)
	pack, err := testDB.Q.InsertStickerPack(t.Context(), sqlc.InsertStickerPackParams{WorkspaceID: uuid.MustParse(f.b.Id), Name: "References", ShortName: "ref" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16]})
	if err != nil {
		t.Fatal(err)
	}
	sticker, err := testDB.Q.InsertSticker(t.Context(), sqlc.InsertStickerParams{PackID: pack.ID, FileID: file.ID, Emoji: "x", Width: 16, Height: 16})
	if err != nil {
		t.Fatal(err)
	}
	var original v1.CreateMessageResponse
	f.local.must(201, "POST", "/api/rooms/"+f.roomB+"/messages", &v1.CreateMessageRequest{StickerId: sticker.ID.String(), Nonce: uniq("sticker-ref-")}, &original)
	copyA := forwardMsg(t, f.local, f.roomB, original.Message.Id, f.roomA, 201)
	stranger := register(t, invite(t, owner(t), f.a.Id))
	dm := openDM(t, f.local, stranger.id, 201).Room.Id
	copyDM := forwardMsg(t, f.local, f.roomB, original.Message.Id, dm, 201)
	identityReferenceRead(t, f.scoped, file, true)
	f.scoped.must(204, "DELETE", "/api/messages/"+copyA.Id, nil, nil)
	identityReferenceRead(t, f.scoped, file, false) // origin pack/uploader and DM are outside A
	identityReferenceRead(t, owner(t), file, true)  // ordinary origin-pack membership
	f.local.must(204, "DELETE", "/api/messages/"+copyDM.Id, nil, nil)
	identityReferenceRead(t, stranger, file, false) // deleting the last live DM copy revokes access
	identityReferenceRead(t, identityReferenceRecovery(t, f), file, false)
}

func TestIdentityFileReferencesPermissionsCanRead(t *testing.T) {
	f := identitySetup(t, "optional")
	o := owner(t)
	file := identityReferenceFile(t, o, f.a.Id)
	original := identityReferenceMessage(t, o, f.roomA, file)
	copyB := forwardMsg(t, o, f.roomA, original.Id, f.roomB, 201)
	o.must(200, "PUT", "/api/rooms/"+f.roomA+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{userOv(f.local.id, 0, perm.ViewRoom)}}, nil)
	identityReferenceRead(t, f.local, file, true) // a denied room cannot hide another allowed room
	o.must(200, "PUT", "/api/rooms/"+f.roomB+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{userOv(f.local.id, 0, perm.ViewRoom)}}, nil)
	identityReferenceRead(t, f.local, file, false) // identity alone never grants VIEW_ROOM
	o.must(204, "DELETE", "/api/messages/"+copyB.Id, nil, nil)
	identityReferenceRead(t, f.local, file, false)
}

func TestIdentityFileReferencesIconsCanRead(t *testing.T) {
	f := identitySetup(t, "optional")
	iconA := identityReferenceFile(t, owner(t), f.a.Id)
	iconB := identityReferenceFile(t, owner(t), f.b.Id)
	for _, icon := range []sqlc.File{iconA, iconB} {
		if _, err := testDB.Q.UpdateWorkspace(t.Context(), sqlc.UpdateWorkspaceParams{ID: *icon.WorkspaceID, SetIcon: true, IconFileID: &icon.ID}); err != nil {
			t.Fatal(err)
		}
	}
	identityReferenceRead(t, f.scoped, iconA, true)
	identityReferenceRead(t, f.scoped, iconB, false)
	identityReferenceRead(t, f.local, iconB, true)
	identityReferenceRead(t, identityReferenceRecovery(t, f), iconA, false)
	original := identityReferenceMessage(t, owner(t), f.roomA, iconA)
	copyB := forwardMsg(t, f.local, f.roomA, original.Id, f.roomB, 201)
	identityReferencePolicy(t, f.a.Id, "enforced")
	f.prove(t, f.scopedSession.ID, time.Now())
	identityReferenceRead(t, f.local, iconA, true) // denied origin icon still has a live B attachment
	f.local.must(204, "DELETE", "/api/messages/"+copyB.Id, nil, nil)
	identityReferenceRead(t, f.local, iconA, false)
	identityReferenceRead(t, f.scoped, iconA, true)
}

func TestIdentityFileReferencesOriginAndProfileCanRead(t *testing.T) {
	f := identitySetup(t, "optional")
	orphanA := identityReferenceFile(t, f.local, f.a.Id)
	orphanB := identityReferenceFile(t, f.local, f.b.Id)
	identityReferenceRead(t, f.scoped, orphanA, true)
	identityReferenceRead(t, f.scoped, orphanB, false)
	identityReferenceRead(t, identityReferenceRecovery(t, f), orphanA, false)

	_, _, old := upload(t, f.local, "/api/me/avatar", "old.png", pngBytes(16, 16))
	_, _, current := upload(t, f.local, "/api/me/avatar", "current.png", pngBytes(20, 20))
	load := func(id string) sqlc.File {
		t.Helper()
		file, err := testDB.Q.GetFile(t.Context(), uuid.MustParse(id))
		if err != nil {
			t.Fatal(err)
		}
		return file
	}
	identityReferenceRead(t, f.scoped, load(old.User.AvatarFileId), false)
	avatar := load(current.User.AvatarFileId)
	identityReferenceRead(t, f.scoped, avatar, true)
	identityReferenceRead(t, f.local, avatar, true)
	identityReferenceRead(t, identityReferenceRecovery(t, f), avatar, false)
	stranger := register(t, invite(t, owner(t), f.b.Id))
	_, _, other := upload(t, stranger, "/api/me/avatar", "other.png", pngBytes(24, 24))
	identityReferenceRead(t, f.scoped, load(other.User.AvatarFileId), false)

	identityReferencePolicy(t, f.a.Id, "enforced")
	f.prove(t, f.scopedSession.ID, time.Now())
	identityReferenceRead(t, f.local, orphanA, false)
	identityReferenceRead(t, f.local, orphanB, true)
	identityReferenceRead(t, f.scoped, orphanA, true)
	f.prove(t, uuid.MustParse(f.local.session), time.Now())
	identityReferenceRead(t, f.local, orphanA, true)

	// Even an ID-only context cannot use the uploader shortcut. WithPolicy must
	// resolve a durable principal, rather than trusting the user ID alone.
	id := auth.Identity{UserID: uuid.MustParse(f.local.id)}
	ctx := auth.WithIdentity(t.Context(), id)
	ctx = perm.WithResolver(ctx, testDB.Q)
	ctx = testApp.Auth.WithPolicy(ctx, id, identitypolicy.WorkspaceRead)
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/files/"+orphanA.ID.String(), http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	if allowed, _ := testApp.Files.CanRead(r, orphanA); allowed {
		t.Fatal("ID-only uploader context authorized file")
	}

	// A failed policy database lookup must remain a dependency error, not fall
	// through to the uploader or another live candidate.
	r = identityReferenceRequest(t.Context(), t, f.local, http.MethodGet)
	cancelled, cancel := context.WithCancel(r.Context())
	cancel()
	if allowed, err := testApp.Files.CanRead(r.WithContext(cancelled), orphanA); allowed || err == nil || httpx.AsError(err).Status != 503 {
		t.Fatalf("database cancellation: allowed=%v err=%v", allowed, err)
	}
}

// This uses the actual App's routes, with no wrapper or overlay. Run it after
// the separately owned GET/HEAD file/thumbnail routing glue is integrated.
func TestIdentityFileReferencesAppRoutes(t *testing.T) {
	f := identitySetup(t, "optional")
	file := identityReferenceFile(t, owner(t), f.a.Id)
	original := identityReferenceMessage(t, owner(t), f.roomA, file)
	copyB := forwardMsg(t, f.local, f.roomA, original.Id, f.roomB, 201)
	stranger := register(t, invite(t, owner(t), f.b.Id))
	bFile := identityReferenceFile(t, f.local, f.b.Id)
	bOriginal := identityReferenceMessage(t, f.local, f.roomB, bFile)
	copyA := forwardMsg(t, f.local, f.roomB, bOriginal.Id, f.roomA, 201)
	check := func(u *user, file sqlc.File, want int) {
		t.Helper()
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			for _, suffix := range []string{"", "/thumbnail"} {
				u.must(want, method, "/api/files/"+file.ID.String()+suffix, nil, nil)
			}
		}
	}
	check(stranger, file, 200)
	check(f.scoped, bFile, 200)
	identityReferencePolicy(t, f.a.Id, "enforced")
	f.prove(t, f.scopedSession.ID, time.Now())
	check(f.local, file, 200) // A denied; B independently allowed
	check(f.scoped, bFile, 200)
	f.scoped.must(204, "DELETE", "/api/messages/"+copyA.Id, nil, nil)
	check(f.scoped, bFile, 403) // scoped uploader cannot use B's remaining original
	f.local.must(204, "DELETE", "/api/messages/"+copyB.Id, nil, nil)
	check(stranger, file, 404)
	check(f.local, file, 403)
}
