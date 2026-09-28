// Package redistest helps integration tests that run against a real Valkey keep to the key
// namespace (redisx.Key, REDIS_KEY_PREFIX).
package redistest

import (
	"context"
	"os"
	"strings"

	"github.com/redis/rueidis"
)

// DefaultPrefix is the namespace integration tests run in unless TEST_REDIS_KEY_PREFIX says
// otherwise: by default (and in CI) a key or channel name built without redisx escapes it and
// fails the run.
const DefaultPrefix = "calab:"

// Prefix returns TEST_REDIS_KEY_PREFIX, or DefaultPrefix when it is unset; set it empty to run
// without a namespace (the historical names).
func Prefix() string {
	if p, ok := os.LookupEnv("TEST_REDIS_KEY_PREFIX"); ok {
		return p
	}
	return DefaultPrefix
}

// Foreign returns the keys of c's logical DB outside the namespace prefix (SCAN), except those
// starting with one of skip (a harness's own keys). Empty prefix: none.
func Foreign(ctx context.Context, c rueidis.Client, prefix string, skip ...string) ([]string, error) {
	var out []string
	for cursor := uint64(0); ; {
		e, err := c.Do(ctx, c.B().Scan().Cursor(cursor).Count(1000).Build()).AsScanEntry()
		if err != nil {
			return nil, err
		}
		for _, k := range e.Elements {
			if !strings.HasPrefix(k, prefix) && !hasAnyPrefix(k, skip) {
				out = append(out, k)
			}
		}
		if cursor = e.Cursor; cursor == 0 {
			return out, nil
		}
	}
}

func hasAnyPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}
