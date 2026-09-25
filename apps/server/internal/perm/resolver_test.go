package perm

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

type fakeStore struct {
	members     map[key]string
	access      map[key]sqlc.GetRoomAccessRow
	memberCalls int
	accessCalls int
	err         error
}

func (f *fakeStore) GetMember(_ context.Context, a sqlc.GetMemberParams) (sqlc.WorkspaceMember, error) {
	f.memberCalls++
	if f.err != nil {
		return sqlc.WorkspaceMember{}, f.err
	}
	role, ok := f.members[key{a.WorkspaceID, a.UserID}]
	if !ok {
		return sqlc.WorkspaceMember{}, pgx.ErrNoRows
	}
	return sqlc.WorkspaceMember{WorkspaceID: a.WorkspaceID, UserID: a.UserID, Role: role}, nil
}

func (f *fakeStore) GetRoomAccess(_ context.Context, a sqlc.GetRoomAccessParams) (sqlc.GetRoomAccessRow, error) {
	f.accessCalls++
	row, ok := f.access[key{a.RoomID, a.UserID}]
	if !ok {
		return sqlc.GetRoomAccessRow{}, pgx.ErrNoRows
	}
	return row, nil
}

func i64(v int64) *int64 { return &v }

func TestResolverRoomAndCache(t *testing.T) {
	ws, room, u := uuid.New(), uuid.New(), uuid.New()
	s := &fakeStore{access: map[key]sqlc.GetRoomAccessRow{
		{room, u}: {WorkspaceID: ws, Role: "member", RoleAllow: i64(0), RoleDeny: i64(int64(Stream))},
	}}
	r := NewResolver(s)
	ctx := context.Background()
	for range 3 {
		acc, err := r.Room(ctx, room, u)
		if err != nil {
			t.Fatal(err)
		}
		if want := Compute(RoleMember, &Override{Deny: Stream}, nil); acc.Bits != want || acc.WorkspaceID != ws {
			t.Fatalf("got %+v, want bits %d", acc, want)
		}
	}
	if s.accessCalls != 1 {
		t.Fatalf("room access loaded %d times, want 1 (cached)", s.accessCalls)
	}
	// Room lookup also primes the workspace role cache.
	if role, err := r.Role(ctx, ws, u); err != nil || role != RoleMember || s.memberCalls != 0 {
		t.Fatalf("role=%q err=%v memberCalls=%d", role, err, s.memberCalls)
	}
	r.Invalidate()
	if _, err := r.Room(ctx, room, u); err != nil || s.accessCalls != 2 {
		t.Fatalf("after invalidate: err=%v calls=%d", err, s.accessCalls)
	}
}

func TestResolverNoAccess(t *testing.T) {
	s := &fakeStore{members: map[key]string{}, access: map[key]sqlc.GetRoomAccessRow{}}
	r := NewResolver(s)
	ctx := context.Background()
	if _, err := r.Room(ctx, uuid.New(), uuid.New()); !errors.Is(err, ErrNoRoom) {
		t.Fatalf("want ErrNoRoom, got %v", err)
	}
	ws, u := uuid.New(), uuid.New()
	if _, _, err := r.Workspace(ctx, ws, u); !errors.Is(err, ErrNotMember) {
		t.Fatalf("want ErrNotMember, got %v", err)
	}
	_, _, _ = r.Workspace(ctx, ws, u)
	if s.memberCalls != 1 {
		t.Fatalf("negative result not cached: %d calls", s.memberCalls)
	}
}

func TestResolverStoreError(t *testing.T) {
	boom := errors.New("boom")
	r := NewResolver(&fakeStore{err: boom})
	if _, err := r.Role(context.Background(), uuid.New(), uuid.New()); !errors.Is(err, boom) {
		t.Fatalf("want wrapped store error, got %v", err)
	}
}

func TestWorkspaceBitsAndComputeIn(t *testing.T) {
	if Workspace(RoleAdmin) != All || Workspace(RoleMember).Has(ManageWorkspace) || Workspace(RoleGuest) != 0 {
		t.Fatal("unexpected workspace-level bits")
	}
	u := uuid.NewString()
	ovs := []OverrideTarget{
		{TargetType: "role", TargetID: "member", Override: Override{Deny: ViewRoom}},
		{TargetType: "user", TargetID: u, Override: Override{Allow: ViewRoom}},
	}
	if ComputeIn(RoleMember, uuid.NewString(), ovs) != 0 {
		t.Fatal("private room visible to other members")
	}
	if !ComputeIn(RoleMember, u, ovs).Has(ViewRoom) {
		t.Fatal("private room hidden from allowed user")
	}
	if ComputeIn(RoleGuest, u, ovs) != ViewRoom|Connect|Speak {
		t.Fatalf("guest with user allow: %d", ComputeIn(RoleGuest, u, ovs))
	}
}
