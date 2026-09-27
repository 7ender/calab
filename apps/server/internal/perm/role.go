package perm

import v1 "github.com/calaba/calaba/server/gen/calaba/v1"

// Valid reports whether r is one of the four built-in workspace roles.
func (r Role) Valid() bool {
	_, ok := RoleDefaults[r]
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

// RoomOnly are the bits that may appear in room overrides. ADMINISTRATOR, MANAGE_WORKSPACE,
// MANAGE_NICKNAMES and MANAGE_ROLES are workspace-level and cannot be granted per room.
const RoomOnly = All &^ (Administrator | ManageWorkspace | ManageNicknames | ManageRoles)

// OverrideTarget is one row of room_permissions.
type OverrideTarget struct {
	TargetType string // "role" | "user"
	TargetID   string // role id or user uuid
	Override
}

// ComputeIn computes a member's permissions in a room from the room's full override list.
func ComputeIn(m Member, overrides []OverrideTarget) Bits {
	ws := m.Workspace()
	if ws&Administrator != 0 {
		return All
	}
	var userOv *Override
	var buf [8]Override
	roleOvs := buf[:0]
	for _, r := range m.Roles { // lowest position first
		for i := range overrides {
			if o := &overrides[i]; o.TargetType == "role" && o.TargetID == r.ID {
				roleOvs = append(roleOvs, o.Override)
				break
			}
		}
	}
	for i := range overrides {
		if o := &overrides[i]; o.TargetType == "user" && o.TargetID == m.UserID {
			userOv = &o.Override
			break
		}
	}
	return ComputeOrdered(ws, roleOvs, userOv)
}
