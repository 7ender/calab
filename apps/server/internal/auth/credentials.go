package auth

import (
	"context"
	"errors"
	"net/http"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
)

// 403, not 401: the caller is authenticated, and a 401 would make clients refresh / log out.
var errWrongPassword = httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_INVALID_CREDENTIALS, "current password is incorrect")

// checkCurrent loads the caller and verifies their current password. Guests have no
// password and cannot change credentials (they are promoted by registration instead).
func (s *Service) checkCurrent(ctx context.Context, userID uuid.UUID, password string) (sqlc.User, error) {
	u, err := s.db.Q.GetUser(ctx, userID)
	if err != nil {
		return u, err
	}
	if u.IsGuest || u.PasswordHash == nil {
		return u, httpx.Forbidden("guest accounts have no password or email")
	}
	ok, err := VerifyPassword(ctx, password, *u.PasswordHash)
	if err != nil && !errors.Is(err, errBadHash) {
		return u, err
	}
	if !ok {
		return u, errWrongPassword
	}
	return u, nil
}

func validateNewPassword(p string) error {
	if n := utf8.RuneCountInString(p); n < 8 || n > 256 {
		return httpx.Validation("newPassword", "password must be 8..256 characters")
	}
	return nil
}

func normalizeNewEmail(e string) (string, error) {
	e, err := NormalizeEmail(e)
	if err != nil {
		return "", httpx.Validation("newEmail", "invalid email address")
	}
	return e, nil
}

// ChangePassword sets a new password and revokes every other session of the user.
func (s *Service) ChangePassword(ctx context.Context, id Identity, current, next string) error {
	if err := validateNewPassword(next); err != nil {
		return err
	}
	if _, err := s.checkCurrent(ctx, id.UserID, current); err != nil {
		return err
	}
	hash, err := HashPassword(ctx, next)
	if err != nil {
		return err
	}
	var revoked []uuid.UUID
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.SetPasswordHash(ctx, sqlc.SetPasswordHashParams{ID: id.UserID, PasswordHash: &hash}); err != nil {
			return err
		}
		revoked, err = q.RevokeOtherUserSessions(ctx, sqlc.RevokeOtherUserSessionsParams{UserID: id.UserID, ID: id.SessionID})
		return err
	})
	if err != nil {
		return err
	}
	for _, sid := range revoked {
		s.afterRevoke(ctx, sid)
	}
	return nil
}

// ChangeEmail changes the login email (unique, case-insensitive). The user's devices get
// USER_UPDATE {me}; the email is private, so nothing goes to other members.
func (s *Service) ChangeEmail(ctx context.Context, id Identity, email, current string) (*v1.Me, error) {
	email, err := normalizeNewEmail(email)
	if err != nil {
		return nil, err
	}
	if _, err := s.checkCurrent(ctx, id.UserID, current); err != nil {
		return nil, err
	}
	u, err := s.db.Q.SetEmail(ctx, sqlc.SetEmailParams{ID: id.UserID, Email: &email})
	if db.UniqueViolation(err) != "" {
		return nil, httpx.Conflict("email is already registered")
	}
	if err != nil {
		return nil, err
	}
	me := pbconv.Me(u)
	s.events.User(ctx, id.UserID, &v1.DispatchEvent{Event: &v1.DispatchEvent_UserUpdate{UserUpdate: &v1.UserUpdate{Me: me}}})
	return me, nil
}

// credentialLimit throttles password checks of an authenticated account (a stolen access
// token must not allow guessing the password to take the account over). Malformed requests
// are rejected before it and do not use the budget.
func (h *Handlers) credentialLimit(r *http.Request, userID uuid.UUID) error {
	return h.cred.Take(r.Context(), userID.String())
}

func (h *Handlers) changePassword(w http.ResponseWriter, r *http.Request) error {
	id := MustFromContext(r.Context())
	var req v1.ChangePasswordRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if err := validateNewPassword(req.GetNewPassword()); err != nil {
		return err
	}
	if err := h.credentialLimit(r, id.UserID); err != nil {
		return err
	}
	if err := h.svc.ChangePassword(r.Context(), id, req.GetCurrentPassword(), req.GetNewPassword()); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

func (h *Handlers) changeEmail(w http.ResponseWriter, r *http.Request) error {
	id := MustFromContext(r.Context())
	var req v1.ChangeEmailRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if _, err := normalizeNewEmail(req.GetNewEmail()); err != nil {
		return err
	}
	if err := h.credentialLimit(r, id.UserID); err != nil {
		return err
	}
	me, err := h.svc.ChangeEmail(r.Context(), id, req.GetNewEmail(), req.GetCurrentPassword())
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.UpdateMeResponse{Me: me})
	return nil
}
