//go:build integration

package app_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/mail"
)

// lockedBuf is a goroutine-safe log sink (the reset mail goes out in the background).
type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// Forgot password (docs/09 #137): the similar-address hint and the diagnostic log line.
func TestForgotPasswordSimilarAccount(t *testing.T) {
	logs := &lockedBuf{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	org, local := uniq("corp"), uniq("kv")
	existing := local + "@" + org + ".ru"
	u, _ := registerRaw(t, existing, invite(t, o, ws.GetId()), "ru")

	forgot := func(email string) *v1.ForgotPasswordResponse {
		var r v1.ForgotPasswordResponse
		newClient(t).must(200, "POST", "/api/auth/password/forgot", &v1.ForgotPasswordRequest{Email: email}, &r)
		return &r
	}
	resets := func(addr string) int {
		return testMail.Count(func(m mail.Message) bool {
			return m.Template == mail.TemplatePasswordReset && strings.EqualFold(m.To, addr)
		})
	}

	// Exact account → false (the answer does not reveal it); the code goes to it.
	if forgot(existing).GetSimilarAccount() {
		t.Fatal("hint for the exact account")
	}
	nthMail(t, 1, mail.TemplatePasswordReset, existing)

	// Sibling domain (.ai instead of .ru) → true, nothing mailed anywhere.
	sibling := local + "@" + org + ".ai"
	if !forgot(sibling).GetSimilarAccount() {
		t.Fatal("no hint for a sibling-domain address")
	}
	// Nothing similar → false.
	nobody := uniq("nobody") + "@" + uniq("elsewhere") + ".ai"
	if forgot(nobody).GetSimilarAccount() {
		t.Fatal("hint for an unrelated address")
	}
	time.Sleep(300 * time.Millisecond) // a stray background send would have landed by now
	if n := resets(existing); n != 1 {
		t.Fatalf("reset mails to the account: %d, want 1", n)
	}
	if n := resets(sibling) + resets(nobody); n != 0 {
		t.Fatalf("reset mail to an address without an account: %d", n)
	}

	// Diagnostics: the guard that stopped the flow, without the address.
	sum := sha256.Sum256([]byte(strings.ToLower(sibling)))
	out := logs.String()
	for _, want := range []string{
		`msg="password reset: no account" domain=` + org + `.ai email_hash=` + hex.EncodeToString(sum[:4]),
		"similar_account=true",
		"ip=10.9.",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("log line %q missing in:\n%s", want, out)
		}
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "password reset") && strings.Contains(line, local) {
			t.Fatalf("the address leaked into the log: %s", line)
		}
	}

	// A disabled account → "not eligible" with the reason, no mail, no hint.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE users SET disabled_at = now() WHERE id = $1", u.id); err != nil {
		t.Fatal(err)
	}
	if forgot(existing).GetSimilarAccount() {
		t.Fatal("hint for a disabled exact account")
	}
	if !strings.Contains(logs.String(), `msg="password reset: account not eligible" user_id=`+u.id+" reason=disabled") {
		t.Fatalf("no not-eligible log line:\n%s", logs.String())
	}
}
