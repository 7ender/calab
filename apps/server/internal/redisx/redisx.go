// Package redisx creates the shared rueidis client.
package redisx

import (
	"context"
	"fmt"
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
	if v := serverVersion(info); !atLeast(v, 7, 4) {
		c.Close()
		return nil, fmt.Errorf("redis: version %q at %s, need >= 7.4 (per-field TTL, HEXPIRE)", v, url)
	}
	return c, nil
}

func serverVersion(info string) string {
	for _, line := range strings.Split(info, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "redis_version:"); ok {
			return v
		}
	}
	return ""
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
