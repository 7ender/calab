package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

func TestCodes(t *testing.T) {
	seen := map[string]bool{}
	for range 50 {
		c, err := newCode()
		if err != nil {
			t.Fatal(err)
		}
		if n, ok := normalizeCode(c); !ok || n != c {
			t.Fatalf("generated code %q is not normal", c)
		}
		seen[c] = true
	}
	if len(seen) < 45 {
		t.Fatalf("codes repeat: %d distinct of 50", len(seen))
	}
	for in, want := range map[string]string{"123456": "123456", " 123 456 ": "123456", "123-456": "123456", "12345": "", "1234567": "", "12a456": "", "１２３４５６": ""} {
		got, ok := normalizeCode(in)
		if (want == "") == ok || got != want {
			t.Errorf("normalizeCode(%q) = %q, %v", in, got, ok)
		}
	}
	// Codes are stored as argon2id hashes.
	h, err := HashPassword(context.Background(), "042917")
	if err != nil {
		t.Fatal(err)
	}
	if ok, _ := VerifyPassword(context.Background(), "042917", h); !ok {
		t.Fatal("code hash")
	}
	if ok, _ := VerifyPassword(context.Background(), "042918", h); ok {
		t.Fatal("wrong code accepted")
	}
}

func TestRequireVerified(t *testing.T) {
	now := time.Now()
	if err := RequireVerified(sqlc.User{EmailVerifiedAt: &now}); err != nil {
		t.Fatal(err)
	}
	if err := RequireVerified(sqlc.User{IsGuest: true}); err != nil {
		t.Fatal("guests are not affected")
	}
	var he *httpx.Error
	if err := RequireVerified(sqlc.User{}); !errors.As(err, &he) || he.Status != 403 || he.Code != v1.ErrorCode_ERROR_CODE_EMAIL_NOT_VERIFIED {
		t.Fatalf("unverified: %v", err)
	}
	if e := retryAfter(1500 * time.Millisecond).(*httpx.Error); e.RetryAfter != 2*time.Second || e.Status != 429 {
		t.Fatalf("retry after %v", e.RetryAfter)
	}
}
