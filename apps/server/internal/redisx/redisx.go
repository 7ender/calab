// Package redisx creates the shared rueidis client.
package redisx

import (
	"context"
	"fmt"
	neturl "net/url"
	"strconv"
	"strings"

	"github.com/redis/rueidis"
)

// Connect opens a client from a redis:// URL and verifies connectivity.
func Connect(ctx context.Context, url string) (rueidis.Client, error) {
	opt, err := rueidis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("redis: parse url: %w", err)
	}
	c, err := rueidis.NewClient(opt)
	if err != nil {
		return nil, fmt.Errorf("redis: connect: %w", err)
	}
	if err := c.Do(ctx, c.B().Ping().Build()).Error(); err != nil {
		c.Close()
		return nil, fmt.Errorf("redis: ping: %w", err)
	}
	info, err := c.Do(ctx, c.B().Info().Section("server").Build()).ToString()
	if err != nil {
		c.Close()
		return nil, fmt.Errorf("redis: info: %w", err)
	}
	if err := checkVersion(info); err != nil {
		c.Close()
		return nil, fmt.Errorf("redis at %s: %w", redactURL(url), err)
	}
	return c, nil
}

// checkVersion requires hash field TTL (HEXPIRE, used for presence): Valkey >= 9.0 or
// Redis >= 7.4. Valkey reports redis_version:7.2.4 for compatibility and its own version
// in valkey_version, so that one decides when present.
func checkVersion(info string) error {
	if v := infoField(info, "valkey_version"); v != "" {
		if !atLeast(v, 9, 0) {
			return fmt.Errorf("valkey version %q, need >= 9.0 (per-field TTL, HEXPIRE)", v)
		}
		return nil
	}
	if v := infoField(info, "redis_version"); !atLeast(v, 7, 4) {
		return fmt.Errorf("redis version %q, need Valkey >= 9.0 or Redis >= 7.4 (per-field TTL, HEXPIRE)", v)
	}
	return nil
}

func infoField(info, name string) string {
	for _, line := range strings.Split(info, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), name+":"); ok {
			return v
		}
	}
	return ""
}

// redactURL drops the password from a redis:// URL for error messages.
func redactURL(raw string) string {
	u, err := neturl.Parse(raw)
	if err != nil {
		return "(invalid url)"
	}
	return u.Redacted()
}

func atLeast(v string, major, minor int) bool {
	parts := strings.SplitN(v, ".", 3)
	if len(parts) < 2 {
		return false
	}
	ma, err1 := strconv.Atoi(parts[0])
	mi, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return false
	}
	return ma > major || (ma == major && mi >= minor)
}
