// Package perm computes effective room permissions.
// Mirror of packages/protocol/src/permissions.ts; both are checked against
// proto/testdata/permissions.json. Keep them in sync.
package perm

// Bits is a permission bit mask (see docs/04-data-model.md).
type Bits uint64

// Permission bits; values match the Permission enum in proto/calaba/v1/permissions.proto.
const (
	ViewRoom        Bits = 1 << 0
	SendMessages    Bits = 1 << 1
	AttachFiles     Bits = 1 << 2
	ManageMessages  Bits = 1 << 3
	Connect         Bits = 1 << 4
	Speak           Bits = 1 << 5
	Stream          Bits = 1 << 6
	MuteMembers     Bits = 1 << 7
	ManageRoom      Bits = 1 << 8
	ManageWorkspace Bits = 1 << 9
	Administrator   Bits = 1 << 10

	All Bits = Administrator<<1 - 1
)

// Role is a workspace role as stored in the DB.
type Role string

// Workspace roles.
const (
	RoleOwner  Role = "owner"
	RoleAdmin  Role = "admin"
	RoleMember Role = "member"
	RoleGuest  Role = "guest"
)

var roleDefaults = map[Role]Bits{
	RoleOwner:  Administrator,
	RoleAdmin:  Administrator,
	RoleMember: ViewRoom | SendMessages | AttachFiles | Connect | Speak | Stream,
	// Guests see only rooms with an explicit VIEW_ROOM allow override.
	RoleGuest: Connect | Speak,
}

// Override is a room-level allow/deny pair.
type Override struct {
	Allow, Deny Bits
}

// Compute returns effective permissions in a room. roleOv/userOv may be nil.
// User override takes precedence over role override. Administrator ignores deny.
func Compute(role Role, roleOv, userOv *Override) Bits {
	p := roleDefaults[role]
	if p&Administrator != 0 {
		return All
	}
	if roleOv != nil {
		p &^= roleOv.Deny
		p |= roleOv.Allow
	}
	if userOv != nil {
		p &^= userOv.Deny
		p |= userOv.Allow
	}
	if p&ViewRoom == 0 {
		return 0
	}
	return p
}

// Has reports whether all bits of p are set.
func (b Bits) Has(p Bits) bool { return b&p == p }
