// Package auth implements accounts and sessions: argon2id passwords, short-lived access
// JWTs and rotating refresh tokens with reuse detection (docs/04-data-model.md, "Auth").
package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	netmail "net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// refreshGrace: presenting the *previous* refresh token within this window after a
// rotation is treated as a benign concurrent refresh (401 without revoking), not reuse.
const refreshGrace = 30 * time.Second

// Service implements the auth use cases.
type Service struct {
	db       *db.DB
	redis    rueidis.Client
	tokens   *Tokens
	events   events.Publisher
	mode     config.RegistrationMode
	refresh  time.Duration
	accessTL time.Duration
	now      func() time.Time

	// Mail sends verification / reset codes (ADR-0023); disabled = no SMTP (addresses are
	// then verified at registration). Set before serving.
	Mail *mail.Service
	// OnEmailVerified runs after an account's address became verified (auto-join of pending
	// email invitations, see workspaces.AcceptEmailInvites) and returns the joined workspaces.
	// Optional.
	OnEmailVerified func(ctx context.Context, u sqlc.User) []uuid.UUID
}

// NewService wires the auth service.
func NewService(cfg *config.Config, d *db.DB, r rueidis.Client, ev events.Publisher) *Service {
	return &Service{
		db:       d,
		redis:    r,
		tokens:   NewTokens([]byte(cfg.JWTSecret), cfg.AccessTokenTTL),
		events:   ev,
		mode:     cfg.RegistrationMode,
		refresh:  cfg.RefreshTokenTTL,
		accessTL: cfg.AccessTokenTTL,
		now:      time.Now,
	}
}

// Tokens exposes the access-token verifier (used by the gateway for IDENTIFY).
func (s *Service) Tokens() *Tokens { return s.tokens }

// Client describes where a request came from; stored on the session.
type Client struct {
	DeviceName string
	IP         string
	UserAgent  string
	Locale     string // supported mail locale from Accept-Language ("" = none)
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// NormalizeEmail trims and validates an email address. Case is kept (citext compares
// case-insensitively).
func NormalizeEmail(s string) (string, error) {
	s = strings.TrimSpace(s)
	if len(s) > 254 {
		return "", httpx.Validation("email", "email is too long")
	}
	a, err := netmail.ParseAddress(s)
	if err != nil || a.Address != s || !strings.Contains(s[strings.LastIndexByte(s, '@'):], ".") {
		return "", httpx.Validation("email", "invalid email address")
	}
	return s, nil
}

// ValidateDisplayName trims and checks a display name (1..64 characters).
func ValidateDisplayName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > 64 {
		return "", httpx.Validation("displayName", "display name must be 1..64 characters")
	}
	return s, nil
}

func validatePassword(p string) error {
	if n := utf8.RuneCountInString(p); n < 8 || n > 256 {
		return httpx.Validation("password", "password must be 8..256 characters")
	}
	return nil
}

var (
	errInvalidCredentials = httpx.Coded(http.StatusUnauthorized, v1.ErrorCode_ERROR_CODE_INVALID_CREDENTIALS, "invalid email or password")
	errInvalidRefresh     = httpx.Coded(http.StatusUnauthorized, v1.ErrorCode_ERROR_CODE_INVALID_REFRESH_TOKEN, "invalid refresh token")
	errInviteInvalid      = httpx.Coded(http.StatusNotFound, v1.ErrorCode_ERROR_CODE_INVITE_INVALID, "invite is invalid, expired or used up")
	errRegistrationClosed = httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_REGISTRATION_CLOSED, "registration requires an invite")
	errInviteEmail        = httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_INVITE_EMAIL_MISMATCH,
		"this invitation was sent to another email address: use that address")
	// errRefreshRace: the previous refresh token was presented within the grace window
	// right after a rotation (another tab / request won). The session is intact: retry with
	// the current token (web: the cookie already holds it). Must not clear the cookie.
	errRefreshRace = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_CONFLICT, "refresh token was just rotated; retry with the current one")
)

// ErrInviteInvalid is shared with the workspaces package.
func ErrInviteInvalid() error { return errInviteInvalid }

// ErrInviteEmailMismatch (403 INVITE_EMAIL_MISMATCH) is shared with the workspaces package.
func ErrInviteEmailMismatch() error { return errInviteEmail }

// Guest accounts (ADR-0016): short sessions renewed by activity; the account is removed
// (anonymised) after GuestInactivity without a refresh.
const (
	GuestSessionTTL = 24 * time.Hour
	GuestInactivity = 7 * 24 * time.Hour
)

// NewGuest creates a guest account named name and its first session inside q.
func (s *Service) NewGuest(ctx context.Context, q *sqlc.Queries, name string, c Client) (sqlc.User, *v1.AuthTokens, error) {
	settings, err := pbconv.EncodeSettings(pbconv.DefaultSettings())
	if err != nil {
		return sqlc.User{}, nil, err
	}
	exp := s.now().Add(GuestInactivity)
	u, err := q.CreateGuestUser(ctx, sqlc.CreateGuestUserParams{DisplayName: name, Settings: settings, GuestExpiresAt: &exp})
	if err != nil {
		return u, nil, err
	}
	tokens, err := s.newSessionTTL(ctx, q, u.ID, c, GuestSessionTTL)
	return u, tokens, err
}

// newSession creates a session row inside q and returns the token pair.
func (s *Service) newSession(ctx context.Context, q *sqlc.Queries, userID uuid.UUID, c Client) (*v1.AuthTokens, error) {
	return s.newSessionTTL(ctx, q, userID, c, s.refresh)
}

func (s *Service) newSessionTTL(ctx context.Context, q *sqlc.Queries, userID uuid.UUID, c Client, ttl time.Duration) (*v1.AuthTokens, error) {
	secret, hash, err := NewRefreshSecret()
	if err != nil {
		return nil, err
	}
	sess, err := q.CreateSession(ctx, sqlc.CreateSessionParams{
		UserID:           userID,
		RefreshTokenHash: hash,
		DeviceName:       clip(c.DeviceName, 64),
		Ip:               clip(c.IP, 64),
		UserAgent:        clip(c.UserAgent, 256),
		ExpiresAt:        s.now().Add(ttl),
	})
	if err != nil {
		return nil, fmt.Errorf("create session: %w", err)
	}
	return s.tokenPair(sess, secret)
}

func (s *Service) tokenPair(sess sqlc.Session, secret string) (*v1.AuthTokens, error) {
	access, exp, err := s.tokens.Issue(sess.UserID, sess.ID)
	if err != nil {
		return nil, err
	}
	return &v1.AuthTokens{
		AccessToken:      access,
		AccessExpiresAt:  timestamppb.New(exp),
		RefreshToken:     FormatRefreshToken(sess.ID, secret),
		RefreshExpiresAt: timestamppb.New(sess.ExpiresAt),
		SessionId:        sess.ID.String(),
	}, nil
}

// Register creates an account and a first session. With REGISTRATION_MODE=invite a valid
// workspace invite is required, except for the very first user of the server (bootstrap).
func (s *Service) Register(ctx context.Context, req *v1.RegisterRequest, c Client) (*v1.RegisterResponse, error) {
	email, err := NormalizeEmail(req.GetEmail())
	if err != nil {
		return nil, err
	}
	name, err := ValidateDisplayName(req.GetDisplayName())
	if err != nil {
		return nil, err
	}
	if err := validatePassword(req.GetPassword()); err != nil {
		return nil, err
	}
	code := strings.TrimSpace(req.GetInviteCode())
	if s.mode == config.RegistrationInvite && code == "" {
		// Cheap pre-check before hashing; re-checked under lock below.
		n, err := s.db.Q.CountUsers(ctx)
		if err != nil {
			return nil, err
		}
		if n > 0 {
			return nil, errRegistrationClosed
		}
	}
	hash, err := HashPassword(ctx, req.GetPassword())
	if err != nil {
		return nil, err
	}
	settings, err := pbconv.EncodeSettings(pbconv.DefaultSettings())
	if err != nil {
		return nil, err
	}

	loc := mail.Supported(req.GetLocale())
	if loc == "" {
		loc = c.Locale
	}
	var locPtr *string
	if loc != "" {
		locPtr = &loc
	}
	// Without SMTP there is nothing to verify with: the address counts as verified.
	var verifiedAt *time.Time
	if !s.mailOn() {
		verifiedAt = ptrTime(s.now())
	}

	var (
		user   sqlc.User
		tokens *v1.AuthTokens
		joined *sqlc.WorkspaceMember
	)
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if s.mode == config.RegistrationInvite && code == "" {
			if err := q.LockRegistration(ctx); err != nil {
				return err
			}
			n, err := q.CountUsers(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				return errRegistrationClosed
			}
		}
		var inv *sqlc.WorkspaceInvite
		role := perm.RoleMember
		if code != "" {
			i, err := q.GetInviteByCode(ctx, code)
			if db.IsNotFound(err) {
				return errInviteInvalid
			}
			if err != nil {
				return err
			}
			ei, err := q.GetEmailInviteByInvite(ctx, i.ID)
			switch {
			case err == nil:
				// An invitation sent by email (ADR-0027): a valid sign-up code for the invited
				// address only. It is not spent here: the user joins after confirming the
				// address (OnEmailVerified → workspaces.AcceptEmailInvites), so a leaked code
				// alone never yields an account with a verified address.
				if ei.AcceptedAt != nil || !inviteLive(i, s.now()) {
					return errInviteInvalid
				}
				if !strings.EqualFold(ei.Email, email) {
					return errInviteEmail
				}
				if s.mailOn() {
					break
				}
				// No SMTP (the invitation predates turning mail off): nothing can confirm the
				// address later, so the emailed code itself is the proof, as before.
				if err := q.AcceptEmailInvite(ctx, ei.ID); err != nil {
					return err
				}
				if _, err := q.ConsumeInvite(ctx, code); err != nil {
					if db.IsNotFound(err) {
						return errInviteInvalid
					}
					return err
				}
				inv, role = &i, perm.Role(ei.Role)
			case db.IsNotFound(err):
				if _, err := q.ConsumeInvite(ctx, code); err != nil {
					if db.IsNotFound(err) {
						return errInviteInvalid
					}
					return err
				}
				inv = &i
			default:
				return err
			}
		}
		user, err = q.CreateUser(ctx, sqlc.CreateUserParams{Email: &email, PasswordHash: &hash, DisplayName: name, Settings: settings,
			Locale: locPtr, EmailVerifiedAt: verifiedAt})
		if db.UniqueViolation(err) != "" {
			return httpx.Conflict("email is already registered")
		}
		if err != nil {
			return err
		}
		if inv != nil {
			// A suspended workspace takes nobody in; a banned address stays out (item 32).
			if err := moderation.CheckSuspended(ctx, q, inv.WorkspaceID); err != nil {
				return err
			}
			if err := moderation.CheckBan(ctx, q, inv.WorkspaceID, user.ID, &email); err != nil {
				return err
			}
			m, err := q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: inv.WorkspaceID, UserID: user.ID, Role: string(role)})
			if err != nil {
				return err
			}
			joined = &m
		}
		tokens, err = s.newSession(ctx, q, user.ID, c)
		return err
	})
	if err != nil {
		return nil, err
	}
	if joined != nil {
		// Role ids come from the member trigger (migration 00021): the built-in role(s).
		ids, err := s.db.Q.ListMemberRoleIDs(ctx, sqlc.ListMemberRoleIDsParams{WorkspaceID: joined.WorkspaceID, UserID: joined.UserID})
		if err == nil {
			s.events.Workspace(ctx, joined.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberAdd{
				WorkspaceMemberAdd: &v1.WorkspaceMemberAdd{Member: pbconv.Member(*joined, user, ids)},
			}})
		}
	}
	if user.EmailVerifiedAt == nil {
		s.sendVerificationQuietly(ctx, user)
	}
	return &v1.RegisterResponse{Tokens: tokens, Me: pbconv.Me(user)}, nil
}

// Login verifies credentials and opens a new session.
func (s *Service) Login(ctx context.Context, req *v1.LoginRequest, c Client) (*v1.LoginResponse, error) {
	email := strings.TrimSpace(req.GetEmail())
	user, err := s.db.Q.GetUserByEmail(ctx, &email)
	if err != nil && !db.IsNotFound(err) {
		return nil, err
	}
	hash := dummyHash
	if err == nil && user.PasswordHash != nil {
		hash = *user.PasswordHash
	}
	ok, verr := VerifyPassword(ctx, req.GetPassword(), hash)
	if verr != nil && !errors.Is(verr, errBadHash) {
		return nil, verr
	}
	if err != nil || !ok || user.PasswordHash == nil || user.DisabledAt != nil {
		return nil, errInvalidCredentials
	}
	// The hash was verified outside any transaction (argon2 takes a while): make sure it is
	// still the current one when the session is created (review 4 L4).
	var tokens *v1.AuthTokens
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		cur, err := q.LockPasswordHash(ctx, user.ID)
		if err != nil {
			return err
		}
		if cur == nil || *cur != *user.PasswordHash {
			return errInvalidCredentials
		}
		tokens, err = s.newSession(ctx, q, user.ID, c)
		return err
	})
	if err != nil {
		return nil, err
	}
	// Unverified (e.g. accounts from before ADR-0023): a fresh code with every sign-in,
	// unless one was sent less than 60 s ago.
	s.sendVerificationQuietly(ctx, user)
	return &v1.LoginResponse{Tokens: tokens, Me: pbconv.Me(user)}, nil
}

// Refresh rotates the refresh token of a session. Replaying a rotated token revokes the
// session (reuse detection), except within refreshGrace of the last rotation.
func (s *Service) Refresh(ctx context.Context, req *v1.RefreshRequest, c Client) (*v1.RefreshResponse, error) {
	sid, secret, ok := ParseRefreshToken(req.GetRefreshToken())
	if !ok {
		return nil, errInvalidRefresh
	}
	presented := HashRefreshSecret(secret)
	var (
		tokens  *v1.AuthTokens
		revoked bool
	)
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		sess, err := q.GetSessionForUpdate(ctx, sid)
		if db.IsNotFound(err) {
			return errInvalidRefresh
		}
		if err != nil {
			return err
		}
		now := s.now()
		if sess.RevokedAt != nil || !now.Before(sess.ExpiresAt) {
			return errInvalidRefresh
		}
		if subtle.ConstantTimeCompare(presented, sess.RefreshTokenHash) != 1 {
			if sess.PrevRefreshTokenHash != nil && sess.RotatedAt != nil &&
				now.Sub(*sess.RotatedAt) < refreshGrace &&
				subtle.ConstantTimeCompare(presented, sess.PrevRefreshTokenHash) == 1 {
				return errRefreshRace // lost a race with a concurrent refresh; keep the session
			}
			if _, err := q.RevokeSession(ctx, sess.ID); err != nil {
				return err
			}
			revoked = true
			return nil // commit the revocation
		}
		user, err := q.GetUser(ctx, sess.UserID)
		if err != nil {
			return err
		}
		if user.DisabledAt != nil {
			if _, err := q.RevokeSession(ctx, sess.ID); err != nil {
				return err
			}
			revoked = true
			return nil
		}
		ttl := s.refresh
		if user.IsGuest && user.GuestExpiresAt != nil { // promoted guests get normal sessions
			ttl = GuestSessionTTL // renewed by activity; the account itself lives 7 days past the last refresh
			if err := q.TouchGuest(ctx, sqlc.TouchGuestParams{ID: user.ID, GuestExpiresAt: ptrTime(now.Add(GuestInactivity))}); err != nil {
				return err
			}
		}
		newSecret, newHash, err := NewRefreshSecret()
		if err != nil {
			return err
		}
		sess, err = q.RotateSession(ctx, sqlc.RotateSessionParams{
			ID:               sess.ID,
			RefreshTokenHash: newHash,
			ExpiresAt:        now.Add(ttl),
			Ip:               clip(c.IP, 64),
			UserAgent:        clip(c.UserAgent, 256),
		})
		if err != nil {
			return err
		}
		tokens, err = s.tokenPair(sess, newSecret)
		return err
	})
	if err != nil {
		return nil, err
	}
	if revoked {
		s.afterRevoke(ctx, sid)
		return nil, errInvalidRefresh
	}
	return &v1.RefreshResponse{Tokens: tokens}, nil
}

// Logout revokes the caller's session, or all of the user's sessions.
func (s *Service) Logout(ctx context.Context, id Identity, all bool) error {
	if all {
		ids, err := s.db.Q.RevokeAllUserSessions(ctx, id.UserID)
		if err != nil {
			return err
		}
		s.afterRevokeMany(ctx, ids)
		return nil
	}
	if _, err := s.db.Q.RevokeSession(ctx, id.SessionID); err != nil {
		return err
	}
	s.afterRevoke(ctx, id.SessionID)
	return nil
}

// LogoutByRefresh revokes the session a refresh token belongs to (or all of its user's
// sessions). The token must be the session's current one or the one rotated within the
// grace window; anything else is rejected without side effects (no reuse revocation here).
func (s *Service) LogoutByRefresh(ctx context.Context, token string, all bool) error {
	sid, secret, ok := ParseRefreshToken(token)
	if !ok {
		return errInvalidRefresh
	}
	sess, err := s.db.Q.GetSession(ctx, sid)
	if db.IsNotFound(err) {
		return errInvalidRefresh
	}
	if err != nil {
		return err
	}
	h := HashRefreshSecret(secret)
	current := subtle.ConstantTimeCompare(h, sess.RefreshTokenHash) == 1
	recent := sess.PrevRefreshTokenHash != nil && sess.RotatedAt != nil && s.now().Sub(*sess.RotatedAt) < refreshGrace &&
		subtle.ConstantTimeCompare(h, sess.PrevRefreshTokenHash) == 1
	if !current && !recent {
		return errInvalidRefresh
	}
	if sess.RevokedAt != nil && !all {
		return nil // already logged out
	}
	return s.Logout(ctx, Identity{UserID: sess.UserID, SessionID: sess.ID}, all)
}

// RevokeSession revokes one of the user's own sessions.
func (s *Service) RevokeSession(ctx context.Context, userID, sessionID uuid.UUID) error {
	n, err := s.db.Q.RevokeUserSession(ctx, sqlc.RevokeUserSessionParams{ID: sessionID, UserID: userID})
	if err != nil {
		return err
	}
	if n == 0 {
		return httpx.NotFound("session")
	}
	s.afterRevoke(ctx, sessionID)
	return nil
}

// ListSessions returns the user's active sessions.
func (s *Service) ListSessions(ctx context.Context, id Identity) (*v1.ListSessionsResponse, error) {
	rows, err := s.db.Q.ListActiveSessions(ctx, id.UserID)
	if err != nil {
		return nil, err
	}
	out := &v1.ListSessionsResponse{Sessions: make([]*v1.Session, len(rows))}
	for i, r := range rows {
		out.Sessions[i] = pbconv.Session(r, id.SessionID)
	}
	return out, nil
}

// MarkRevoked makes sessions revoked in the DB by someone else (e.g. guest cleanup)
// effective immediately: live access tokens are rejected and the gateway drops the sockets.
func (s *Service) MarkRevoked(ctx context.Context, sids ...uuid.UUID) { s.afterRevokeMany(ctx, sids) }

func revokedKey(sid uuid.UUID) string { return "auth:revoked:" + sid.String() }

// revokeBudget is the Redis time a revocation gets for its markers, and again for its
// socket-close events. It is deliberately not taken from the request's shared post-commit
// budget (events.RequestBudget): "log out everywhere" after a slow reorder or with a
// sluggish Redis must still kill the access tokens now, not leave them alive until they
// expire (≤ ACCESS_TOKEN_TTL).
const revokeBudget = 3 * time.Second

// afterRevoke makes outstanding access tokens of the session invalid immediately (Redis
// marker living as long as an access token can) and tells the gateway to drop the socket.
func (s *Service) afterRevoke(ctx context.Context, sid uuid.UUID) {
	s.afterRevokeMany(ctx, []uuid.UUID{sid})
}

// afterRevokeMany is afterRevoke for several sessions: all markers in one pipeline, then
// the socket-close events — each step with its own revokeBudget.
func (s *Service) afterRevokeMany(ctx context.Context, sids []uuid.UUID) {
	if len(sids) == 0 {
		return
	}
	ctx = context.WithoutCancel(ctx)
	ttl := s.accessTL + time.Minute
	cmds := make(rueidis.Commands, len(sids))
	for i, sid := range sids {
		cmds[i] = s.redis.B().Set().Key(revokedKey(sid)).Value("1").Ex(ttl).Build()
	}
	mctx, done := events.Detached(events.WithBudget(ctx, revokeBudget), revokeBudget)
	res := s.redis.DoMulti(mctx, cmds...)
	for i, sid := range sids {
		if i < len(res) {
			if err := res[i].Error(); err != nil {
				// Access tokens of this session stay valid until expiry (≤ ACCESS_TOKEN_TTL).
				slog.WarnContext(ctx, "mark session revoked failed", "session_id", sid, "err", err)
			}
		}
	}
	done()
	pctx := events.WithBudget(ctx, revokeBudget)
	for _, sid := range sids {
		s.events.SessionRevoked(pctx, sid)
	}
}

// IsRevoked reports whether the session was revoked while access tokens may still be live.
// Uses rueidis client-side caching: Redis invalidates the cached value on SET.
func (s *Service) IsRevoked(ctx context.Context, sid uuid.UUID) (bool, error) {
	err := s.redis.DoCache(ctx, s.redis.B().Get().Key(revokedKey(sid)).Cache(), s.accessTL).Error()
	if rueidis.IsRedisNil(err) {
		return false, nil
	}
	return err == nil, err
}

// inviteLive: not expired and not used up.
func inviteLive(i sqlc.WorkspaceInvite, now time.Time) bool {
	return (i.ExpiresAt == nil || now.Before(*i.ExpiresAt)) && (i.MaxUses == 0 || i.Uses < i.MaxUses)
}

func ptrTime(t time.Time) *time.Time { return &t }
