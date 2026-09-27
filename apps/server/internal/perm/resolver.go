package perm

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// ErrNotMember means the user is not a member of the workspace.
var ErrNotMember = errors.New("perm: not a workspace member")

// ErrNoRoom means the room does not exist (or is archived) or the user is not a member of its
// workspace (of a DM: not one of its two participants).
var ErrNoRoom = errors.New("perm: room not accessible")

// Store is the subset of sqlc queries the resolver needs.
type Store interface {
	GetMemberAccess(ctx context.Context, arg sqlc.GetMemberAccessParams) (sqlc.GetMemberAccessRow, error)
	GetRoomAccess(ctx context.Context, arg sqlc.GetRoomAccessParams) (sqlc.GetRoomAccessRow, error)
}

// RoomAccess is a user's resolved access to a room.
type RoomAccess struct {
	WorkspaceID uuid.UUID // uuid.Nil for a DM
	Role        Role      // highest built-in role; "" for a DM
	Bits        Bits
	// Member: the member's roles (zero for a DM); Member.Workspace() = workspace-level bits.
	Member Member
	// DM rooms (ADR-0020): the two participants. They get the room's events on their user
	// channels instead of a workspace channel.
	DM      bool
	Members []uuid.UUID
	// Suspended: the workspace is suspended by a superadmin (read-only; item 32).
	Suspended bool
}

// ok reports a resolved access (the zero value = no access).
func (a RoomAccess) ok() bool { return a.WorkspaceID != uuid.Nil || a.DM }

type key struct{ a, b uuid.UUID }

// Resolver loads roles + overrides from the DB and computes effective permissions.
// It caches results for its lifetime; create one per request (see WithResolver).
type Resolver struct {
	store   Store
	mu      sync.Mutex
	members map[key]Member     // (workspace, user) -> member; Role "" = not a member
	rooms   map[key]RoomAccess // (room, user) -> access; zero value = no access
}

// NewResolver returns an empty resolver.
func NewResolver(s Store) *Resolver {
	return &Resolver{store: s, members: map[key]Member{}, rooms: map[key]RoomAccess{}}
}

// RoleList zips the parallel role arrays of a query row.
func RoleList(ids []uuid.UUID, positions []int32, perms []int64) []RoleBits {
	n := min(len(ids), len(positions), len(perms))
	out := make([]RoleBits, n)
	for i := range n {
		out[i] = RoleBits{ID: ids[i].String(), Position: positions[i], Permissions: Bits(uint64(perms[i]))} //nolint:gosec // bit mask round-trip
	}
	return out
}

// Member returns the user's roles in the workspace, or ErrNotMember.
func (r *Resolver) Member(ctx context.Context, workspaceID, userID uuid.UUID) (Member, error) {
	k := key{workspaceID, userID}
	r.mu.Lock()
	m, ok := r.members[k]
	r.mu.Unlock()
	if !ok {
		row, err := r.store.GetMemberAccess(ctx, sqlc.GetMemberAccessParams{WorkspaceID: workspaceID, UserID: userID})
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			m = Member{}
		case err != nil:
			return Member{}, fmt.Errorf("perm: load member: %w", err)
		default:
			m = NewMember(userID.String(), Role(row.Role), RoleList(row.RoleIds, row.RolePositions, row.RolePermissions))
		}
		r.mu.Lock()
		r.members[k] = m
		r.mu.Unlock()
	}
	if m.Role == "" {
		return Member{}, ErrNotMember
	}
	return m, nil
}

// Role returns the user's highest built-in role in the workspace, or ErrNotMember.
func (r *Resolver) Role(ctx context.Context, workspaceID, userID uuid.UUID) (Role, error) {
	m, err := r.Member(ctx, workspaceID, userID)
	return m.Role, err
}

// Workspace returns the user's workspace-level permissions and highest built-in role.
func (r *Resolver) Workspace(ctx context.Context, workspaceID, userID uuid.UUID) (Bits, Role, error) {
	m, err := r.Member(ctx, workspaceID, userID)
	if err != nil {
		return 0, "", err
	}
	return m.Workspace(), m.Role, nil
}

// Room returns the user's effective permissions in a room, or ErrNoRoom.
func (r *Resolver) Room(ctx context.Context, roomID, userID uuid.UUID) (RoomAccess, error) {
	k := key{roomID, userID}
	r.mu.Lock()
	acc, ok := r.rooms[k]
	r.mu.Unlock()
	if !ok {
		row, err := r.store.GetRoomAccess(ctx, sqlc.GetRoomAccessParams{RoomID: roomID, UserID: userID})
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			acc = RoomAccess{}
		case err != nil:
			return RoomAccess{}, fmt.Errorf("perm: load room access: %w", err)
		case row.Type == "dm":
			if slices.Contains(row.DmMembers, userID) {
				acc = RoomAccess{Bits: ComputeDM(true), DM: true, Members: row.DmMembers}
			}
		case row.WorkspaceID != nil && row.Role != nil:
			// The query returns the roles lowest position first, each with its override
			// in this room (0/0 = none, which changes nothing).
			m := Member{UserID: userID.String(), Role: Role(*row.Role), Roles: RoleList(row.RoleIds, row.RolePositions, row.RolePermissions)}
			n := min(len(row.RoleAllows), len(row.RoleDenies))
			ovs := make([]Override, n)
			for i := range n {
				ovs[i] = Override{Allow: Bits(uint64(row.RoleAllows[i])), Deny: Bits(uint64(row.RoleDenies[i]))} //nolint:gosec // bit mask round-trip
			}
			acc = RoomAccess{
				WorkspaceID: *row.WorkspaceID,
				Role:        m.Role,
				Member:      m,
				Bits:        ComputeOrdered(m.Workspace(), ovs, override(row.UserAllow, row.UserDeny)),
				Suspended:   row.Suspended,
			}
		}
		r.mu.Lock()
		r.rooms[k] = acc
		if acc.WorkspaceID != uuid.Nil {
			r.members[key{acc.WorkspaceID, userID}] = acc.Member
		}
		r.mu.Unlock()
	}
	if !acc.ok() {
		return RoomAccess{}, ErrNoRoom
	}
	return acc, nil
}

// Invalidate drops cached results (call after mutating roles or overrides in the same request).
func (r *Resolver) Invalidate() {
	r.mu.Lock()
	clear(r.members)
	clear(r.rooms)
	r.mu.Unlock()
}

func override(allow, deny *int64) *Override {
	if allow == nil || deny == nil {
		return nil
	}
	return &Override{Allow: Bits(uint64(*allow)), Deny: Bits(uint64(*deny))} //nolint:gosec // bit mask round-trip
}

type ctxKey struct{}

// WithResolver installs a fresh per-request resolver into ctx.
func WithResolver(ctx context.Context, s Store) context.Context {
	return context.WithValue(ctx, ctxKey{}, NewResolver(s))
}

// FromContext returns the request's resolver. It panics if none was installed, which is a
// wiring bug (the perm middleware must wrap all authenticated routes).
func FromContext(ctx context.Context) *Resolver {
	r, ok := ctx.Value(ctxKey{}).(*Resolver)
	if !ok {
		panic("perm: no resolver in context")
	}
	return r
}
