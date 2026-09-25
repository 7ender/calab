package workspaces

import (
	"strings"
	"testing"
)

func TestValidateSlug(t *testing.T) {
	good := []string{"abc", "team-1", "a1b", "0-0", strings.Repeat("a", 32), "my-team-2026"}
	bad := []string{"", "ab", strings.Repeat("a", 33), "Team", "te_am", "-abc", "abc-", "a--b", "api", "join",
		"тим", "a b", "a.b"}
	for _, s := range good {
		if err := ValidateSlug(s); err != nil {
			t.Errorf("%q rejected: %v", s, err)
		}
	}
	for _, s := range bad {
		if err := ValidateSlug(s); err == nil {
			t.Errorf("%q accepted", s)
		}
	}
}

func TestInviteCode(t *testing.T) {
	seen := map[string]bool{}
	for range 1000 {
		c, err := newInviteCode()
		if err != nil {
			t.Fatal(err)
		}
		if len(c) != inviteCodeLen || seen[c] {
			t.Fatalf("bad or repeated code %q", c)
		}
		for _, r := range c {
			if !strings.ContainsRune(inviteAlphabet, r) {
				t.Fatalf("code %q has char outside alphabet", c)
			}
		}
		seen[c] = true
	}
}
