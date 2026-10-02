// Package dbtest gives package-level integration tests an isolated, migrated PostgreSQL
// database. The server comes from TEST_DATABASE_URL (TEST_PG_URL as a fallback), the same
// admin URL internal/app and CI use; there is no built-in default address, so a missing
// variable fails the test instead of silently reaching some other cluster.
package dbtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/db"
)

// AdminURL returns the admin URL of an existing database on the test server.
func AdminURL() (string, error) {
	for _, key := range []string{"TEST_DATABASE_URL", "TEST_PG_URL"} {
		if v := os.Getenv(key); v != "" {
			return v, nil
		}
	}
	return "", fmt.Errorf("TEST_DATABASE_URL (or TEST_PG_URL) required: admin URL of the integration PostgreSQL")
}

var (
	once    sync.Once
	shared  string // URL of this process's database
	initErr error
)

// Connect returns a new pool to this test binary's own database, created and migrated on the
// first call (packages run in parallel in CI, so they never share one schema). The pool is
// closed by t.Cleanup; the database is dropped by Run.
func Connect(t testing.TB) *db.DB {
	t.Helper()
	ctx := context.Background()
	once.Do(func() { shared, initErr = create(ctx) })
	if initErr != nil {
		t.Fatal(initErr)
	}
	d, err := db.Connect(ctx, shared)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	return d
}

func create(ctx context.Context) (string, error) {
	admin, err := AdminURL()
	if err != nil {
		return "", err
	}
	c, err := pgx.Connect(ctx, admin)
	if err != nil {
		return "", fmt.Errorf("postgres unavailable: %w", err)
	}
	defer func() { _ = c.Close(ctx) }()
	var b [6]byte
	_, _ = rand.Read(b[:])
	name := "calaba_pkg_" + hex.EncodeToString(b[:])
	if _, err = c.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		return "", err
	}
	u, err := url.Parse(admin)
	if err != nil {
		return "", err
	}
	u.Path = "/" + name
	d, err := db.Connect(ctx, u.String())
	if err != nil {
		return "", err
	}
	defer d.Close()
	if err = d.Migrate(ctx); err != nil {
		return "", err
	}
	return u.String(), nil
}

// Run runs the package's tests and drops the database Connect created, if any.
func Run(m *testing.M) int {
	code := m.Run()
	if shared == "" {
		return code
	}
	ctx := context.Background()
	u, _ := url.Parse(shared)
	name := u.Path[1:]
	admin, _ := AdminURL()
	c, err := pgx.Connect(ctx, admin)
	if err == nil {
		_, err = c.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)")
		_ = c.Close(ctx)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "dbtest: drop %s: %v\n", name, err)
	}
	return code
}
