package perm

import (
	"context"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Roles indexes a workspace's roles by id (uuid text).
type Roles map[string]RoleBits

// RolesOf indexes role rows.
func RolesOf(rows []sqlc.WorkspaceRole) Roles {
	out := make(Roles, len(rows))
	for _, r := range rows {
		out[r.ID.String()] = RoleBits{ID: r.ID.String(), Position: r.Position, Permissions: Bits(uint64(r.Permissions))} //nolint:gosec // bit mask round-trip
	}
	return out
}

// Member builds a member from their role ids; unknown ids are skipped.
func (rs Roles) Member(userID string, role Role, ids []string) Member {
	roles := make([]RoleBits, 0, len(ids))
	for _, id := range ids {
		if r, ok := rs[id]; ok {
			roles = append(roles, r)
		}
	}
	return NewMember(userID, role, roles)
}

// WorkspaceStore is what LoadMembers needs.
type WorkspaceStore interface {
	ListWorkspaceRoles(ctx context.Context, workspaceID uuid.UUID) ([]sqlc.WorkspaceRole, error)
	ListWorkspaceMemberRoles(ctx context.Context, workspaceID uuid.UUID) ([]sqlc.ListWorkspaceMemberRolesRow, error)
}

// LoadMembers loads all members of a workspace with their roles (two queries).
func LoadMembers(ctx context.Context, s WorkspaceStore, workspaceID uuid.UUID) (map[uuid.UUID]Member, error) {
	roles, err := s.ListWorkspaceRoles(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	rows, err := s.ListWorkspaceMemberRoles(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	rs := RolesOf(roles)
	out := make(map[uuid.UUID]Member, len(rows))
	for _, r := range rows {
		out[r.UserID] = rs.Member(r.UserID.String(), Role(r.Role), IDStrings(r.RoleIds))
	}
	return out, nil
}

// IDStrings converts uuids to their text form.
func IDStrings(ids []uuid.UUID) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = id.String()
	}
	return out
}
