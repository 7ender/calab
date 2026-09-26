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
	GetMember(ctx context.Context, arg sqlc.GetMemberParams) (sqlc.WorkspaceMember, error)
	GetRoomAccess(ctx context.Context, arg sqlc.GetRoomAccessParams) (sqlc.GetRoomAccessRow, error)
}

// RoomAccess is a user's resolved access to a room.
type RoomAccess struct {
	WorkspaceID uuid.UUID // uuid.Nil for a DM
	Role        Role      // "" for a DM
	Bits        Bits
	// DM rooms (ADR-0020): the two participants. They get the room's events on their user
	// channels instead of a workspace channel.
	DM      bool
	Members []uuid.UUID
}

// ok reports a resolved access (the zero value = no access).
func (a RoomAccess) ok() bool { return a.WorkspaceID != uuid.Nil || a.DM }

type key struct{ a, b uuid.UUID }

// Resolver loads role + overrides from the DB and computes effective permissions.
// It caches results for its lifetime; create one per request (see WithResolver).
type Resolver struct {
	store Store
	mu    sync.Mutex
	roles map[key]Role       // (workspace, user) -> role; "" = not a member
	rooms map[key]RoomAccess // (room, user) -> access; zero value = no access
}

// NewResolver returns an empty resolver.
func NewResolver(s Store) *Resolver {
	return &Resolver{store: s, roles: map[key]Role{}, rooms: map[key]RoomAccess{}}
}

// Role returns the user's role in the workspace, or ErrNotMember.
func (r *Resolver) Role(ctx context.Context, workspaceID, userID uuid.UUID) (Role, error) {
	k := key{workspaceID, userID}
	r.mu.Lock()
	role, ok := r.roles[k]
	r.mu.Unlock()
	if !ok {
		m, err := r.store.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: workspaceID, UserID: userID})
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			role = ""
		case err != nil:
			return "", fmt.Errorf("perm: load member: %w", err)
		default:
			role = Role(m.Role)
		}
		r.mu.Lock()
		r.roles[k] = role
		r.mu.Unlock()
	}
	if role == "" {
		return "", ErrNotMember
	}
	return role, nil
}

// Workspace returns the user's workspace-level permissions and role.
func (r *Resolver) Workspace(ctx context.Context, workspaceID, userID uuid.UUID) (Bits, Role, error) {
	role, err := r.Role(ctx, workspaceID, userID)
	if err != nil {
		return 0, "", err
	}
	return Workspace(role), role, nil
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
			role := Role(*row.Role)
			acc = RoomAccess{
				WorkspaceID: *row.WorkspaceID,
				Role:        role,
				Bits:        Compute(role, override(row.RoleAllow, row.RoleDeny), override(row.UserAllow, row.UserDeny)),
			}
		}
		r.mu.Lock()
		r.rooms[k] = acc
		if acc.WorkspaceID != uuid.Nil {
			r.roles[key{acc.WorkspaceID, userID}] = acc.Role
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
	clear(r.roles)
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
