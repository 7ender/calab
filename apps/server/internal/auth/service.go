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
	"net/mail"
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
	a, err := mail.ParseAddress(s)
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
)

// ErrInviteInvalid is shared with the workspaces package.
func ErrInviteInvalid() error { return errInviteInvalid }

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
		if code != "" {
			i, err := q.ConsumeInvite(ctx, code)
			if db.IsNotFound(err) {
				return errInviteInvalid
			}
			if err != nil {
				return err
			}
			inv = &i
		}
		user, err = q.CreateUser(ctx, sqlc.CreateUserParams{Email: &email, PasswordHash: &hash, DisplayName: name, Settings: settings})
		if db.UniqueViolation(err) != "" {
			return httpx.Conflict("email is already registered")
		}
		if err != nil {
			return err
		}
		if inv != nil {
			m, err := q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: inv.WorkspaceID, UserID: user.ID, Role: string(perm.RoleMember)})
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
		s.events.Workspace(ctx, joined.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberAdd{
			WorkspaceMemberAdd: &v1.WorkspaceMemberAdd{Member: pbconv.Member(*joined, user)},
		}})
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
	tokens, err := s.newSession(ctx, s.db.Q, user.ID, c)
	if err != nil {
		return nil, err
	}
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
				return errInvalidRefresh // lost a race with a concurrent refresh; keep the session
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
		if user.IsGuest {
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
		for _, sid := range ids {
			s.afterRevoke(ctx, sid)
		}
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

// MarkRevoked makes a session revoked in the DB by someone else (e.g. guest cleanup)
// effective immediately: live access tokens are rejected and the gateway drops the socket.
func (s *Service) MarkRevoked(ctx context.Context, sid uuid.UUID) { s.afterRevoke(ctx, sid) }

func revokedKey(sid uuid.UUID) string { return "auth:revoked:" + sid.String() }

// afterRevoke makes outstanding access tokens of the session invalid immediately (Redis
// marker living as long as an access token can) and tells the gateway to drop the socket.
func (s *Service) afterRevoke(ctx context.Context, sid uuid.UUID) {
	ctx = context.WithoutCancel(ctx)
	ttl := s.accessTL + time.Minute
	cmd := s.redis.B().Set().Key(revokedKey(sid)).Value("1").Ex(ttl).Build()
	if err := s.redis.Do(ctx, cmd).Error(); err != nil {
		// Access tokens of this session stay valid until expiry (≤ ACCESS_TOKEN_TTL).
		slog.WarnContext(ctx, "mark session revoked failed", "session_id", sid, "err", err)
	}
	s.events.SessionRevoked(ctx, sid)
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

func ptrTime(t time.Time) *time.Time { return &t }
