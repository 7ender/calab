package perm

import (
	"encoding/json"
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
	RoomType    string `json:"roomType"`
	Participant bool   `json:"participant"`
	Expected    Bits   `json:"expected"`
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
			if got := ComputeRoles(roles, v.RoleOverrides, v.UserOverride); got != v.Expected {
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
			m := NewMember(uid, RoleMember, roles)
			if got := ComputeIn(m, ovs); got != v.Expected {
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
	if RoomOnly&(ManageRoles|ManageWorkspace|Administrator|ManageNicknames) != 0 || All != 1<<16-1 {
		t.Fatal("workspace-level bits must not be settable per room")
	}
	if GuestMax&^RoleDefaults[RoleMember] != 0 || RoleDefaults[RoleGuest]&^GuestMax != 0 {
		t.Fatal("guest bounds")
	}
}
