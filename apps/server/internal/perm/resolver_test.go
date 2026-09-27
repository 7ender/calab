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
	members     map[key]sqlc.GetMemberAccessRow
	access      map[key]sqlc.GetRoomAccessRow
	memberCalls int
	accessCalls int
	err         error
}

func (f *fakeStore) GetMemberAccess(_ context.Context, a sqlc.GetMemberAccessParams) (sqlc.GetMemberAccessRow, error) {
	f.memberCalls++
	if f.err != nil {
		return sqlc.GetMemberAccessRow{}, f.err
	}
	row, ok := f.members[key{a.WorkspaceID, a.UserID}]
	if !ok {
		return sqlc.GetMemberAccessRow{}, pgx.ErrNoRows
	}
	return row, nil
}

func (f *fakeStore) GetRoomAccess(_ context.Context, a sqlc.GetRoomAccessParams) (sqlc.GetRoomAccessRow, error) {
	f.accessCalls++
	row, ok := f.access[key{a.RoomID, a.UserID}]
	if !ok {
		return sqlc.GetRoomAccessRow{}, pgx.ErrNoRows
	}
	return row, nil
}

func ptr[T any](v T) *T { return &v }

func TestResolverRoomAndCache(t *testing.T) {
	ws, room, u := uuid.New(), uuid.New(), uuid.New()
	member, mod := uuid.New(), uuid.New()
	// member (deny STREAM here) and a custom role at position 2 (allow MOVE_MEMBERS here).
	s := &fakeStore{access: map[key]sqlc.GetRoomAccessRow{
		{room, u}: {
			WorkspaceID: &ws, Type: "voice", Role: ptr("member"),
			RoleIds: []uuid.UUID{member, mod}, RolePositions: []int32{1, 2},
			RolePermissions: []int64{i64(RoleDefaults[RoleMember]), i64(MuteMembers)},
			RoleAllows:      []int64{0, int64(MoveMembers)}, RoleDenies: []int64{int64(Stream), 0},
		},
	}}
	r := NewResolver(s)
	ctx := context.Background()
	want := ComputeRoles([]RoleBits{
		{ID: "m", Position: 1, Permissions: RoleDefaults[RoleMember]}, {ID: "x", Position: 2, Permissions: MuteMembers},
	}, Scope{}, map[string]Override{"m": {Deny: Stream}, "x": {Allow: MoveMembers}}, nil)
	for range 3 {
		acc, err := r.Room(ctx, room, u)
		if err != nil {
			t.Fatal(err)
		}
		if acc.Bits != want || acc.WorkspaceID != ws || acc.Bits.Has(Stream) || !acc.Bits.Has(MoveMembers|MuteMembers) {
			t.Fatalf("got %+v, want bits %d", acc, want)
		}
	}
	if s.accessCalls != 1 {
		t.Fatalf("room access loaded %d times, want 1 (cached)", s.accessCalls)
	}
	// Room lookup also primes the workspace member cache.
	bits, role, err := r.Workspace(ctx, ws, u)
	if err != nil || role != RoleMember || s.memberCalls != 0 || bits != RoleDefaults[RoleMember]|MuteMembers {
		t.Fatalf("role=%q bits=%d err=%v memberCalls=%d", role, bits, err, s.memberCalls)
	}
	r.Invalidate()
	if _, err := r.Room(ctx, room, u); err != nil || s.accessCalls != 2 {
		t.Fatalf("after invalidate: err=%v calls=%d", err, s.accessCalls)
	}
}

func TestResolverMember(t *testing.T) {
	ws, u := uuid.New(), uuid.New()
	admin, member := uuid.New(), uuid.New()
	s := &fakeStore{members: map[key]sqlc.GetMemberAccessRow{
		{ws, u}: {Role: "admin", RoleIds: []uuid.UUID{member, admin}, RolePositions: []int32{PosMember, PosAdmin},
			RolePermissions: []int64{i64(RoleDefaults[RoleMember]), i64(Administrator)}},
	}}
	r := NewResolver(s)
	m, err := r.Member(context.Background(), ws, u)
	if err != nil || m.Workspace() != All || m.Top() != PosAdmin || m.Role != RoleAdmin || !m.Has(admin.String()) {
		t.Fatalf("member %+v err %v", m, err)
	}
}

func TestResolverDM(t *testing.T) {
	room, a, b, c := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	row := sqlc.GetRoomAccessRow{Type: "dm", DmMembers: []uuid.UUID{a, b}}
	// A workspace role of the caller never applies to a DM (defence in depth: the query
	// cannot join one, since a DM has no workspace).
	s := &fakeStore{access: map[key]sqlc.GetRoomAccessRow{{room, a}: row, {room, c}: row}}
	r := NewResolver(s)
	ctx := context.Background()
	acc, err := r.Room(ctx, room, a)
	if err != nil || !acc.DM || acc.Bits != DM || acc.WorkspaceID != uuid.Nil || len(acc.Members) != 2 {
		t.Fatalf("participant: %+v %v", acc, err)
	}
	if acc.Bits.Has(ManageMessages) || acc.Bits.Has(MentionEveryone) || acc.Bits.Has(Connect) {
		t.Fatalf("DM bits include moderation / voice: %d", acc.Bits)
	}
	if _, err := r.Room(ctx, room, c); !errors.Is(err, ErrNoRoom) {
		t.Fatalf("third user: want ErrNoRoom, got %v", err)
	}
	if _, err := r.Room(ctx, room, c); !errors.Is(err, ErrNoRoom) || s.accessCalls != 2 {
		t.Fatalf("negative DM result not cached: %v, %d calls", err, s.accessCalls)
	}
}

func TestResolverNoAccess(t *testing.T) {
	s := &fakeStore{members: map[key]sqlc.GetMemberAccessRow{}, access: map[key]sqlc.GetRoomAccessRow{}}
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

func TestComputeInPrivateRoom(t *testing.T) {
	memberID, guestID := uuid.NewString(), uuid.NewString()
	roles := Roles{
		memberID: {ID: memberID, Position: PosMember, Permissions: RoleDefaults[RoleMember]},
		guestID:  {ID: guestID, Position: PosGuest, Permissions: RoleDefaults[RoleGuest]},
	}
	u := uuid.NewString()
	ovs := []OverrideTarget{
		{TargetType: "role", TargetID: memberID, Override: Override{Deny: ViewRoom}},
		{TargetType: "user", TargetID: u, Override: Override{Allow: ViewRoom}},
	}
	if ComputeIn(roles.Member(uuid.NewString(), RoleMember, []string{memberID}), false, ovs) != 0 {
		t.Fatal("private room visible to other members")
	}
	if !ComputeIn(roles.Member(u, RoleMember, []string{memberID}), false, ovs).Has(ViewRoom) {
		t.Fatal("private room hidden from allowed user")
	}
	if got := ComputeIn(roles.Member(u, RoleGuest, []string{guestID, "unknown"}), false, ovs); got != ViewRoom|Connect|Speak {
		t.Fatalf("guest with user allow: %d", got)
	}
}

func i64(b Bits) int64 { return int64(b) } //nolint:gosec // small bit masks in tests

// ADR-0029: in a restricted room an admin counts as a plain member, the owner has everything.
func TestResolverRestricted(t *testing.T) {
	ws, room := uuid.New(), uuid.New()
	adminU, ownerU := uuid.New(), uuid.New()
	adminR, ownerR, memberR := uuid.New(), uuid.New(), uuid.New()
	row := func(role string, top uuid.UUID, pos int32) sqlc.GetRoomAccessRow {
		return sqlc.GetRoomAccessRow{
			WorkspaceID: &ws, Type: "text", Role: ptr(role), Restricted: true,
			RoleIds: []uuid.UUID{memberR, top}, RolePositions: []int32{PosMember, pos},
			RolePermissions: []int64{i64(RoleDefaults[RoleMember]), i64(Administrator)},
			RoleAllows:      []int64{0, 0}, RoleDenies: []int64{int64(ViewRoom), 0},
		}
	}
	s := &fakeStore{access: map[key]sqlc.GetRoomAccessRow{
		{room, adminU}: row("admin", adminR, PosAdmin),
		{room, ownerU}: row("owner", ownerR, PosOwner),
	}}
	r := NewResolver(s)
	ctx := context.Background()
	if acc, err := r.Room(ctx, room, adminU); err != nil || acc.Bits != 0 || !acc.Restricted {
		t.Fatalf("admin: %+v %v", acc, err)
	}
	if acc, err := r.Room(ctx, room, ownerU); err != nil || acc.Bits != All {
		t.Fatalf("owner: %+v %v", acc, err)
	}
}
