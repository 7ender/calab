package config

import "testing"

func TestAllowedOrigins(t *testing.T) {
	c := &Config{PublicAppURL: "https://App.Example.com/", PublicAppURLAlt: "https://app.example.ru:8443/x"}
	got := c.AllowedOrigins()
	if len(got) != 2 || got[0] != "https://app.example.com" || got[1] != "https://app.example.ru:8443" {
		t.Fatalf("%v", got)
	}
	for _, bad := range []string{"app.example.com", "ftp://x", "", "https://"} {
		if Origin(bad) != "" {
			t.Errorf("%q accepted", bad)
		}
	}
}
