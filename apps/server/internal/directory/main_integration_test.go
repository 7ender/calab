//go:build integration

package directory

import (
	"os"
	"testing"

	"github.com/calaba/calaba/server/internal/db/dbtest"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }
