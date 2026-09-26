package perm

import (
	"encoding/json"
	"os"
	"testing"
)

type vector struct {
	Name         string    `json:"name"`
	Role         Role      `json:"role"`
	RoleOverride *Override `json:"roleOverride"`
	UserOverride *Override `json:"userOverride"`
	// DM vectors (ADR-0020): roomType "dm" ignores role and overrides.
	RoomType    string `json:"roomType"`
	Participant bool   `json:"participant"`
	Expected    Bits   `json:"expected"`
}

func TestComputeVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../proto/testdata/permissions.json")
	if err != nil {
		t.Fatal(err)
	}
	var vs []vector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatal(err)
	}
	for _, v := range vs {
		if v.RoomType == "dm" {
			if got := ComputeDM(v.Participant); got != v.Expected {
				t.Errorf("%s: got %d want %d", v.Name, got, v.Expected)
			}
			continue
		}
		if got := Compute(v.Role, v.RoleOverride, v.UserOverride); got != v.Expected {
			t.Errorf("%s: got %d want %d", v.Name, got, v.Expected)
		}
	}
}
