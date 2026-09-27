// Package superadmin knows the product superadmins (ADR-0024): users whose email is listed in
// SUPERADMIN_EMAILS. The flag is never stored — it is derived from the current email on every
// use, so removing an address from the env (or changing the account's email) revokes it at
// once. The list is process-wide configuration, set once at startup.
package superadmin

import (
	"strings"
	"sync/atomic"
)

var emails atomic.Pointer[map[string]bool]

// Configure sets the superadmin emails (case-insensitive; blanks ignored).
func Configure(list []string) {
	m := make(map[string]bool, len(list))
	for _, e := range list {
		if e = normalize(e); e != "" {
			m[e] = true
		}
	}
	emails.Store(&m)
}

// Is reports whether email belongs to a superadmin.
func Is(email string) bool {
	m := emails.Load()
	e := normalize(email)
	return m != nil && e != "" && (*m)[e]
}

// IsPtr is Is for a nullable email (guest accounts have none).
func IsPtr(email *string) bool { return email != nil && Is(*email) }

func normalize(e string) string { return strings.ToLower(strings.TrimSpace(e)) }
