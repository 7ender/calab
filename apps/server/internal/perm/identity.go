package perm

import (
	"context"
	"github.com/google/uuid"
)

type accessGuardKey struct{}

// AccessGuard checks the caller's session before resource permissions. The user argument
// may be another member being inspected; it never substitutes for the caller principal.
type AccessGuard func(context.Context, uuid.UUID, uuid.UUID) error

// WithAccessGuard installs the session-specific policy gate without coupling perm to auth.
func WithAccessGuard(ctx context.Context, guard AccessGuard) context.Context {
	return context.WithValue(ctx, accessGuardKey{}, guard)
}

// CheckAccess gates nested resources when a session is attached. Background permission
// calculations without a session remain pure; their session consumers must gate separately.
func CheckAccess(ctx context.Context, ws, user uuid.UUID) error {
	if guard, ok := ctx.Value(accessGuardKey{}).(AccessGuard); ok {
		return guard(ctx, ws, user)
	}
	return nil
}
