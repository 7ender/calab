package config

import (
	"strings"
	"testing"
)

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

func TestPublicAppURLs(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x@localhost/x")
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("PUBLIC_APP_URL", "https://app.calab.ru")
	t.Setenv("PUBLIC_APP_URL_ALT", "https://colaba.gptunnel.ai")
	t.Setenv("PUBLIC_APP_URLS", "https://app.calab.ru, https://Colaba.GPTunnel.ru/ ,https://colaba.gptunnel.ai")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(c.AllowedOrigins(), " ")
	if got != "https://app.calab.ru https://colaba.gptunnel.ai https://colaba.gptunnel.ru" {
		t.Fatalf("origins: %s", got)
	}
	t.Setenv("PUBLIC_APP_URLS", "https://ok.example, calab.ru")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "PUBLIC_APP_URLS") {
		t.Fatalf("bad entry accepted: %v", err)
	}
}
