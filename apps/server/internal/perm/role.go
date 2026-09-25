package perm

import v1 "github.com/calaba/calaba/server/gen/calaba/v1"

// Valid reports whether r is one of the four workspace roles.
func (r Role) Valid() bool {
	_, ok := roleDefaults[r]
	return ok
}

// Proto converts a DB role to the wire enum.
func (r Role) Proto() v1.WorkspaceRole {
	switch r {
	case RoleOwner:
		return v1.WorkspaceRole_WORKSPACE_ROLE_OWNER
	case RoleAdmin:
		return v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	case RoleMember:
		return v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER
	case RoleGuest:
		return v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	}
	return v1.WorkspaceRole_WORKSPACE_ROLE_UNSPECIFIED
}

// RoleFromProto converts the wire enum; ok=false for UNSPECIFIED/unknown.
func RoleFromProto(r v1.WorkspaceRole) (Role, bool) {
	switch r {
	case v1.WorkspaceRole_WORKSPACE_ROLE_OWNER:
		return RoleOwner, true
	case v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN:
		return RoleAdmin, true
	case v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER:
		return RoleMember, true
	case v1.WorkspaceRole_WORKSPACE_ROLE_GUEST:
		return RoleGuest, true
	}
	return "", false
}

// Workspace returns workspace-level permissions of a role: role defaults without room
// overrides (used for MANAGE_WORKSPACE and for creating rooms, which needs MANAGE_ROOM).
func Workspace(role Role) Bits {
	return Compute(role, nil, nil)
}

// RoomOnly are the bits that may appear in room overrides. ADMINISTRATOR and
// MANAGE_WORKSPACE are workspace-level and cannot be granted per room.
const RoomOnly = All &^ (Administrator | ManageWorkspace)

// OverrideTarget is one row of room_permissions.
type OverrideTarget struct {
	TargetType string // "role" | "user"
	TargetID   string // role name or user uuid
	Override
}

// ComputeIn computes a user's permissions in a room from the room's full override list.
func ComputeIn(role Role, userID string, overrides []OverrideTarget) Bits {
	var roleOv, userOv *Override
	for i := range overrides {
		o := &overrides[i]
		switch {
		case o.TargetType == "role" && o.TargetID == string(role):
			roleOv = &o.Override
		case o.TargetType == "user" && o.TargetID == userID:
			userOv = &o.Override
		}
	}
	return Compute(role, roleOv, userOv)
}
