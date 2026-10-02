//go:build integration

package sso

import (
	"os"
	"testing"

	"github.com/calaba/calaba/server/internal/db/dbtest"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }
