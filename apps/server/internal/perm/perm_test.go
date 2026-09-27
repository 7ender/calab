package perm

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

type vectorRole struct {
	ID          string `json:"id"`
	Position    int32  `json:"position"`
	Permissions Bits   `json:"permissions"`
}

type vector struct {
	Name         string    `json:"name"`
	Role         Role      `json:"role"`
	RoleOverride *Override `json:"roleOverride"`
	UserOverride *Override `json:"userOverride"`
	// ADR-0026 vectors: the member's roles and the room's overrides by role id.
	Roles             []vectorRole        `json:"roles"`
	RoleOverrides     map[string]Override `json:"roleOverrides"`
	ExpectedWorkspace *Bits               `json:"expectedWorkspace"`
	// DM vectors (ADR-0020): roomType "dm" ignores role and overrides.
	RoomType string `json:"roomType"`
	// ADR-0029: a restricted room and whether the member is the workspace owner.
	Restricted  bool `json:"restricted"`
	Owner       bool `json:"owner"`
	Participant bool `json:"participant"`
	Expected    Bits `json:"expected"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	raw, err := os.ReadFile("../../../../proto/testdata/permissions.json")
	if err != nil {
		t.Fatal(err)
	}
	var vs []vector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatal(err)
	}
	return vs
}

func TestComputeVectors(t *testing.T) {
	n := 0
	for _, v := range loadVectors(t) {
		switch {
		case v.RoomType == "dm":
			if got := ComputeDM(v.Participant); got != v.Expected {
				t.Errorf("%s: got %d want %d", v.Name, got, v.Expected)
			}
		case v.Roles != nil:
			n++
			roles := make([]RoleBits, len(v.Roles))
			for i, r := range v.Roles {
				roles[i] = RoleBits(r)
			}
			if got := ComputeRoles(roles, Scope{Restricted: v.Restricted, Owner: v.Owner}, v.RoleOverrides, v.UserOverride); got != v.Expected {
				t.Errorf("%s: ComputeRoles got %d want %d", v.Name, got, v.Expected)
			}
			// The same rule through a member and the room's override list (gateway, snapshots).
			const uid = "u1"
			var ovs []OverrideTarget
			for id, o := range v.RoleOverrides {
				ovs = append(ovs, OverrideTarget{TargetType: "role", TargetID: id, Override: o})
			}
			if v.UserOverride != nil {
				ovs = append(ovs, OverrideTarget{TargetType: "user", TargetID: uid, Override: *v.UserOverride})
			}
			role := RoleMember
			if v.Owner {
				role = RoleOwner
			}
			m := NewMember(uid, role, roles)
			if got := ComputeIn(m, v.Restricted, ovs); got != v.Expected {
				t.Errorf("%s: ComputeIn got %d want %d", v.Name, got, v.Expected)
			}
			if v.ExpectedWorkspace != nil && m.Workspace() != *v.ExpectedWorkspace {
				t.Errorf("%s: workspace got %d want %d", v.Name, m.Workspace(), *v.ExpectedWorkspace)
			}
		default:
			if got := Compute(v.Role, v.RoleOverride, v.UserOverride); got != v.Expected {
				t.Errorf("%s: got %d want %d", v.Name, got, v.Expected)
			}
		}
	}
	if n < 12 {
		t.Fatalf("only %d multi-role vectors", n)
	}
}

func TestMemberTopAndRoomOnly(t *testing.T) {
	m := NewMember("u", RoleAdmin, []RoleBits{{ID: "a", Position: PosAdmin}, {ID: "m", Position: PosMember}, {ID: "c", Position: 5}})
	if m.Top() != PosAdmin || m.Roles[0].ID != "m" || !m.Has("c") || m.Has("x") {
		t.Fatalf("member %+v top %d", m, m.Top())
	}
	if (Member{}).Top() != -1 {
		t.Fatal("no roles: top -1")
	}
	if RoomOnly&(ManageRoles|ManageWorkspace|Administrator|ManageNicknames|ManageStickers) != 0 || All != 1<<17-1 {
		t.Fatal("workspace-level bits must not be settable per room")
	}
	if GuestMax&^RoleDefaults[RoleMember] != 0 || RoleDefaults[RoleGuest]&^GuestMax != 0 {
		t.Fatal("guest bounds")
	}
}

// BenchmarkComputeIn50Roles100Rooms: a member holding all 50 roles, 100 rooms with an
// override for every role and a user override (the worst case of a READY snapshot).
func BenchmarkComputeIn50Roles100Rooms(b *testing.B) {
	roles := make([]RoleBits, 50)
	for i := range roles {
		roles[i] = RoleBits{ID: fmt.Sprintf("r%02d", i), Position: int32(i), Permissions: Bits(1) << (i % 10)} //nolint:gosec // < 50
	}
	m := NewMember("u", RoleMember, roles)
	rooms := make([][]OverrideTarget, 100)
	for i := range rooms {
		for j, r := range roles {
			rooms[i] = append(rooms[i], OverrideTarget{TargetType: "role", TargetID: r.ID, Override: Override{Allow: Bits(1) << (j % 9), Deny: ViewRoom * Bits(j%2)}})
		}
		rooms[i] = append(rooms[i], OverrideTarget{TargetType: "user", TargetID: "u", Override: Override{Allow: ViewRoom}})
	}
	b.ResetTimer()
	for range b.N {
		for _, ovs := range rooms {
			_ = ComputeIn(m, false, ovs)
		}
	}
}
