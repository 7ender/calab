package workspaces

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// TestValidateAppURLVectors: the rule shared with the desktop client (proto/testdata/app_urls.json).
func TestValidateAppURLVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../proto/testdata/app_urls.json")
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Cases []struct {
			URL string `json:"url"`
			OK  bool   `json:"ok"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	if len(data.Cases) < 40 {
		t.Fatalf("only %d vectors", len(data.Cases))
	}
	for _, c := range data.Cases {
		got, err := ValidateAppURL(c.URL)
		if (err == nil) != c.OK {
			t.Errorf("%q: ok=%v, want %v", c.URL, err == nil, c.OK)
		}
		if err == nil && got != strings.TrimSpace(c.URL) {
			t.Errorf("%q: returned %q", c.URL, got)
		}
	}
}

func TestValidateAppURLLength(t *testing.T) {
	base := "https://example.com/"
	if _, err := ValidateAppURL(base + strings.Repeat("a", MaxAppURLLen-len(base))); err != nil {
		t.Fatalf("2048 characters: %v", err)
	}
	if _, err := ValidateAppURL(base + strings.Repeat("a", MaxAppURLLen-len(base)+1)); err == nil {
		t.Fatal("2049 characters accepted")
	}
}
