package workspaces

import (
	"strings"
	"unicode/utf8"

	"github.com/calaba/calaba/server/internal/httpx"
)

// reservedSlugs cannot be used as workspace slugs (future routes / confusion).
var reservedSlugs = map[string]bool{
	"api": true, "admin": true, "app": true, "calaba": true, "discover": true, "gateway": true,
	"join": true, "invite": true, "invites": true, "me": true, "new": true, "settings": true,
	"static": true, "www": true, "help": true, "support": true, "system": true,
}

// ValidateSlug checks a workspace slug: 3..32 chars of [a-z0-9-], starting and ending with a
// letter or digit, no "--", not reserved. Slugs are not normalized: "Team" is rejected, not
// lowercased, so the client shows the user exactly what will be stored.
func ValidateSlug(s string) error {
	if len(s) < 3 || len(s) > 32 {
		return httpx.Validation("slug", "slug must be 3..32 characters")
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
			return httpx.Validation("slug", "slug may contain only a-z, 0-9 and '-'")
		}
	}
	if s[0] == '-' || s[len(s)-1] == '-' || strings.Contains(s, "--") {
		return httpx.Validation("slug", "slug must start and end with a letter or digit and must not contain '--'")
	}
	if reservedSlugs[s] {
		return httpx.Validation("slug", "slug is reserved")
	}
	return nil
}

func validateName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > 100 {
		return "", httpx.Validation("name", "name must be 1..100 characters")
	}
	return s, nil
}

func validateNickname(s string) (string, error) {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > 64 {
		return "", httpx.Validation("nickname", "nickname must be at most 64 characters")
	}
	return s, nil
}
