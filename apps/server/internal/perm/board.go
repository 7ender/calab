package perm

// BoardScope carries the board-level inputs of the rule besides the overrides (ADR-0042).
type BoardScope struct {
	// Private: boards.is_private — VIEW_BOARD comes only from an override (a role's or the
	// user's own), not from the roles' permissions.
	Private bool
	// Guest: the member's highest built-in role is guest — guests never see boards.
	Guest bool
	// Restricted: boards.restricted (ADR-0048, only on a private board) — ADMINISTRATOR gives
	// no bypass; the owner (Owner) gets everything.
	Restricted bool
	// Owner: the user is the workspace owner (holder of the built-in owner role).
	Owner bool
}

// BoardScopeOf returns the scope of member m on a board.
func BoardScopeOf(m Member, private, restricted bool) BoardScope {
	return BoardScope{Private: private || restricted, Guest: m.Role == RoleGuest, Restricted: restricted, Owner: m.Role == RoleOwner}
}

// ComputeBoard is the board form of the one permission rule (ADR-0042, ADR-0048): the order of
// ComputeOrdered (ADMINISTRATOR → everything, each role's override lowest position first, then
// the user's), but the overrides touch only BoardOnly bits, a private board first drops the
// roles' VIEW_BOARD, and without VIEW_BOARD there is nothing. Guests get nothing. On a
// restricted board the owner gets everything and ADMINISTRATOR is dropped (like a restricted
// room). Mirror of computePermissions({board}) in packages/protocol.
func ComputeBoard(raw Bits, sc BoardScope, roleOvs []Override, userOv *Override) Bits {
	switch {
	case sc.Guest:
		return 0
	case sc.Restricted && sc.Owner:
		return All
	case sc.Restricted:
		raw &^= Administrator | ViewBoard
	case raw&Administrator != 0:
		return All
	}
	p := raw
	if sc.Private {
		p &^= ViewBoard
	}
	for _, o := range roleOvs {
		p &^= o.Deny & BoardOnly
		p |= o.Allow & BoardOnly
	}
	if userOv != nil {
		p &^= userOv.Deny & BoardOnly
		p |= userOv.Allow & BoardOnly
	}
	if p&ViewBoard == 0 {
		return 0
	}
	return p
}

// ComputeBoardIn computes a member's board permissions from the board's override list;
// restricted is boards.restricted (ADR-0048).
func ComputeBoardIn(m Member, private, restricted bool, overrides []OverrideTarget) Bits {
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
	return ComputeBoard(m.Raw(), BoardScopeOf(m, private, restricted), roleOvs, userOv)
}

// ComputeBoardRoles is ComputeBoard from the member's roles (any order) and the board's role
// overrides by role id (the shared test vectors).
func ComputeBoardRoles(roles []RoleBits, sc BoardScope, roleOvs map[string]Override, userOv *Override) Bits {
	m := NewMember("", "", roles)
	ovs := make([]Override, 0, len(m.Roles))
	for _, r := range m.Roles {
		if o, ok := roleOvs[r.ID]; ok {
			ovs = append(ovs, o)
		}
	}
	return ComputeBoard(m.Raw(), sc, ovs, userOv)
}

// TaskRoom maps board bits to the bits in a task's comment room (ADR-0042 §1): VIEW_BOARD →
// VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES, EDIT_TASKS adds MANAGE_MESSAGES. The room of an
// archived task is read-only. Room overrides do not apply.
func TaskRoom(board Bits, archived bool) Bits {
	if !board.Has(ViewBoard) {
		return 0
	}
	p := ViewRoom
	if !archived {
		p |= SendMessages | AttachFiles
	}
	if board.Has(EditTasks) {
		p |= ManageMessages
	}
	return p
}
