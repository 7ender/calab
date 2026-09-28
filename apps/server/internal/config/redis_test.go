package config

import (
	"strings"
	"testing"
)

func TestRedisKeyPrefix(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x@localhost/x")
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	longest := strings.Repeat("a", 63) + ":" // 64 bytes
	for _, p := range []string{"", "calab:", "calab:prod:", "Tenant-1.calab_x:", longest} {
		t.Setenv("REDIS_KEY_PREFIX", p)
		if c, err := Load(); err != nil || c.RedisKeyPrefix != p {
			t.Errorf("%q: rejected or changed: %v", p, err)
		}
	}
	// No final ':', too long, glob characters (the gateway PSUBSCRIBEs to "<prefix>*"), spaces.
	for _, p := range []string{"calab", "a" + longest, "calab*:", "ca?lab:", "[calab]:", `c\alab:`, "calab :", "calab:\n", "калаб:"} {
		t.Setenv("REDIS_KEY_PREFIX", p)
		if _, err := Load(); err == nil || !strings.Contains(err.Error(), "REDIS_KEY_PREFIX") {
			t.Errorf("%q: accepted (%v)", p, err)
		}
	}
}
