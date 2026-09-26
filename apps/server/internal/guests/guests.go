// Package guests implements room links and guest accounts (ADR-0016): a link is a capability
// for one room; registered users join the workspace as `guest` (if not members) with access
// to that room; without an account, a guest account is created from a nickname.
package guests

import (
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/calaba/calaba/server/internal/workspaces"
)

const (
	codeAlphabet     = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"
	codeLen          = 12 // ≈ 70 bits: the code is the capability
	defaultExpiry    = 7 * 24 * time.Hour
	maxExpiry        = 365 * 24 * time.Hour
	maxUses          = 10000
	cleanupBatchSize = 200
)

// Service serves room links and guest lifecycle.
type Service struct {
	db      *db.DB
	auth    *auth.Service
	events  events.Publisher
	store   blob.Store
	limiter *redisx.RateLimiter // guest creation per IP (5/h)
	origins []string
}

// NewService creates the guests service.
func NewService(d *db.DB, a *auth.Service, ev events.Publisher, store blob.Store, limiter *redisx.RateLimiter, origins []string) *Service {
	return &Service{db: d, auth: a, events: ev, store: store, limiter: limiter, origins: origins}
}

// Routes registers the routes: link management needs auth (wrap); preview and join are public (join
// authenticates optionally).
func (s *Service) Routes(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /api/rooms/{id}/invites", wrap(httpx.HandlerFunc(s.create)))
	mux.Handle("GET /api/rooms/{id}/invites", wrap(httpx.HandlerFunc(s.list)))
	mux.Handle("DELETE /api/rooms/{id}/invites/{inviteId}", wrap(httpx.HandlerFunc(s.revoke)))
	mux.Handle("GET /api/room-invites/{code}", httpx.HandlerFunc(s.preview))
	mux.Handle("POST /api/room-invites/{code}/join", httpx.HandlerFunc(s.join))
}

func newCode() (string, error) {
	b := make([]byte, codeLen)
	n := big.NewInt(int64(len(codeAlphabet)))
	for i := range b {
		k, err := rand.Int(rand.Reader, n)
		if err != nil {
			return "", err
		}
		b[i] = codeAlphabet[k.Int64()]
	}
	return string(b), nil
}

// AllowBits computes what joiners may do: VIEW_ROOM + CONNECT always, plus the flags.
func AllowBits(speak, messages, files, stream bool) perm.Bits {
	b := perm.ViewRoom | perm.Connect
	if speak {
		b |= perm.Speak
	}
	if messages {
		b |= perm.SendMessages
	}
	if files {
		b |= perm.AttachFiles
	}
	if stream {
		b |= perm.Stream
	}
	return b
}

func toProto(i sqlc.RoomInvite, wsID uuid.UUID) *v1.RoomInvite {
	b := perm.Bits(uint64(i.AllowBits)) //nolint:gosec // bit mask
	out := &v1.RoomInvite{
		Id: i.ID.String(), RoomId: i.RoomID.String(), WorkspaceId: wsID.String(), Code: i.Code,
		CreatedBy: i.CreatedBy.String(), MaxUses: uint32(max(i.MaxUses, 0)), Uses: uint32(max(i.Uses, 0)),
		AllowGuests: i.AllowGuests, AllowSpeak: b.Has(perm.Speak), AllowMessages: b.Has(perm.SendMessages),
		AllowFiles: b.Has(perm.AttachFiles), AllowStream: b.Has(perm.Stream), CreatedAt: timestamppb.New(i.CreatedAt),
	}
	if i.ExpiresAt != nil {
		out.ExpiresAt = timestamppb.New(*i.ExpiresAt)
	}
	return out
}

func manage(r *http.Request) (uuid.UUID, perm.RoomAccess, error) {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return uuid.Nil, perm.RoomAccess{}, err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return roomID, acc, err
	}
	if !acc.Bits.Has(perm.ManageRoom) {
		return roomID, acc, httpx.Forbidden("MANAGE_ROOM required")
	}
	return roomID, acc, nil
}

func orDefault(b *bool, def bool) bool {
	if b == nil {
		return def
	}
	return *b
}

func (s *Service) create(w http.ResponseWriter, r *http.Request) error {
	roomID, acc, err := manage(r)
	if err != nil {
		return err
	}
	var req v1.CreateRoomInviteRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if req.GetMaxUses() > maxUses {
		return httpx.Validation("maxUses", "maxUses must be 0..10000")
	}
	var expires *time.Time
	d := defaultExpiry
	if req.ExpiresInSeconds != nil {
		d = time.Duration(req.GetExpiresInSeconds()) * time.Second
	}
	if d > maxExpiry {
		return httpx.Validation("expiresInSeconds", "links expire in at most 365 days")
	}
	if d > 0 {
		t := time.Now().Add(d)
		expires = &t
	}
	bits := AllowBits(orDefault(req.AllowSpeak, true), orDefault(req.AllowMessages, true),
		orDefault(req.AllowFiles, false), orDefault(req.AllowStream, false))
	if !acc.Bits.Has(perm.Administrator) && bits&^acc.Bits != 0 {
		return httpx.Forbidden("cannot grant permissions you do not have") // no escalation through links
	}
	uid := auth.MustFromContext(r.Context()).UserID
	for range 3 {
		code, err := newCode()
		if err != nil {
			return err
		}
		inv, err := s.db.Q.CreateRoomInvite(r.Context(), sqlc.CreateRoomInviteParams{
			RoomID: roomID, Code: code, CreatedBy: uid, ExpiresAt: expires,
			MaxUses: int32(req.GetMaxUses()), AllowGuests: orDefault(req.AllowGuests, true), AllowBits: int64(bits), //nolint:gosec // bounded
		})
		if db.UniqueViolation(err) != "" {
			continue
		}
		if err != nil {
			return err
		}
		httpx.Write(w, http.StatusCreated, &v1.CreateRoomInviteResponse{Invite: toProto(inv, acc.WorkspaceID)})
		return nil
	}
	return errors.New("guests: invite code collisions")
}

func (s *Service) list(w http.ResponseWriter, r *http.Request) error {
	roomID, acc, err := manage(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Q.ListRoomInvites(r.Context(), roomID)
	if err != nil {
		return err
	}
	out := &v1.ListRoomInvitesResponse{Invites: make([]*v1.RoomInvite, len(rows))}
	for i, inv := range rows {
		out.Invites[i] = toProto(inv, acc.WorkspaceID)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func (s *Service) revoke(w http.ResponseWriter, r *http.Request) error {
	roomID, _, err := manage(r)
	if err != nil {
		return err
	}
	invID, err := httpx.PathUUID(r, "inviteId", "invite")
	if err != nil {
		return err
	}
	n, err := s.db.Q.RevokeRoomInvite(r.Context(), sqlc.RevokeRoomInviteParams{ID: invID, RoomID: roomID})
	if err != nil {
		return err
	}
	if n == 0 {
		return httpx.NotFound("invite")
	}
	httpx.NoContent(w)
	return nil
}

func (s *Service) load(ctx context.Context, code string) (sqlc.GetRoomInviteByCodeRow, error) {
	row, err := s.db.Q.GetRoomInviteByCode(ctx, code)
	if db.IsNotFound(err) {
		return row, auth.ErrInviteInvalid()
	}
	return row, err
}

// preview: GET /api/room-invites/{code} — public, for the /r/<code> page.
func (s *Service) preview(w http.ResponseWriter, r *http.Request) error {
	row, err := s.load(r.Context(), r.PathValue("code"))
	if err != nil {
		return err
	}
	out := &v1.GetRoomInviteResponse{
		RoomName: row.Room.Name, WorkspaceName: row.Workspace.Name, AllowGuests: row.RoomInvite.AllowGuests,
		RoomType: v1.RoomType_ROOM_TYPE_TEXT,
	}
	if row.Room.Type == "voice" {
		out.RoomType = v1.RoomType_ROOM_TYPE_VOICE
	}
	if row.Workspace.IconFileID != nil {
		out.WorkspaceIconFileId = row.Workspace.IconFileID.String()
	}
	if row.RoomInvite.ExpiresAt != nil {
		out.ExpiresAt = timestamppb.New(*row.RoomInvite.ExpiresAt)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// grant gives userID access to the room inside q: membership as `guest` if needed and a
// user override with the link's bits. It consumes one use of the link only when access
// actually changes. Returns the new membership (nil if the user already was a member).
func grant(ctx context.Context, q *sqlc.Queries, row sqlc.GetRoomInviteByCodeRow, userID uuid.UUID) (*sqlc.WorkspaceMember, bool, error) {
	wsID, roomID := row.Workspace.ID, row.Room.ID
	member, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: wsID, UserID: userID})
	isMember := err == nil
	if err != nil && !db.IsNotFound(err) {
		return nil, false, err
	}
	if isMember {
		acc, err := perm.NewResolver(q).Room(ctx, roomID, userID)
		if err != nil && !errors.Is(err, perm.ErrNoRoom) {
			return nil, false, err
		}
		if acc.Bits.Has(perm.ViewRoom) {
			return nil, false, nil // (a) already has access: nothing to change, no use consumed
		}
	}
	if _, err := q.ConsumeRoomInvite(ctx, row.RoomInvite.ID); err != nil {
		if db.IsNotFound(err) {
			return nil, false, auth.ErrInviteInvalid()
		}
		return nil, false, err
	}
	var added *sqlc.WorkspaceMember
	if !isMember { // (b)/(c): join as guest — the role sees no room without an override
		m, err := q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: wsID, UserID: userID, Role: string(perm.RoleGuest)})
		if err != nil {
			return nil, false, err
		}
		added, member = &m, m
	}
	_ = member
	if _, err := q.UpsertUserOverride(ctx, sqlc.UpsertUserOverrideParams{RoomID: roomID, UserID: userID.String(), Allow: row.RoomInvite.AllowBits}); err != nil {
		return nil, false, err
	}
	return added, true, nil
}

// announce publishes the membership and the room's new overrides after a join.
func (s *Service) announce(ctx context.Context, row sqlc.GetRoomInviteByCodeRow, added *sqlc.WorkspaceMember) {
	ovs, err := s.db.Q.ListRoomOverrides(ctx, row.Room.ID)
	if err == nil {
		pbs := make([]*v1.RoomPermissionOverride, len(ovs))
		for i, o := range ovs {
			pbs[i] = pbconv.Override(o)
		}
		s.events.Workspace(ctx, row.Workspace.ID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomPermissionsUpdate{
			RoomPermissionsUpdate: &v1.RoomPermissionsUpdate{WorkspaceId: row.Workspace.ID.String(), RoomId: row.Room.ID.String(), Permissions: pbs},
		}})
	}
	if added != nil {
		workspaces.AnnounceJoin(ctx, s.db.Q, s.events, row.Workspace, *added)
	}
}

// join: POST /api/room-invites/{code}/join — scenarios (a)(b) with an access token,
// (c) without one (guest account from `nickname`).
func (s *Service) join(w http.ResponseWriter, r *http.Request) error {
	row, err := s.load(r.Context(), r.PathValue("code"))
	if err != nil {
		return err
	}
	var req v1.JoinRoomInviteRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	resp := &v1.JoinRoomInviteResponse{RoomId: row.Room.ID.String(), WorkspaceId: row.Workspace.ID.String()}

	if auth.HasBearer(r) {
		id, err := s.auth.Authenticate(r)
		if err != nil {
			return err
		}
		var added *sqlc.WorkspaceMember
		changed := false
		err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
			var err error
			added, changed, err = grant(r.Context(), q, row, id.UserID)
			return err
		})
		if err != nil {
			return err
		}
		if changed {
			s.announce(r.Context(), row, added)
		}
		httpx.Write(w, http.StatusOK, resp)
		return nil
	}

	// (c) no account.
	if !row.RoomInvite.AllowGuests {
		return httpx.Unauthenticated("sign in to use this link")
	}
	if auth.IsWeb(r) && !httpx.SameOrigin(r, s.origins) {
		return httpx.Forbidden("cross-origin request rejected") // it sets a session cookie
	}
	name, err := auth.ValidateDisplayName(req.GetNickname())
	if err != nil {
		return httpx.Validation("nickname", "name must be 1..64 characters")
	}
	if err := s.limiter.Take(r.Context(), httpx.ClientIP(r.Context())); err != nil {
		return err
	}
	var (
		user   sqlc.User
		tokens *v1.AuthTokens
		added  *sqlc.WorkspaceMember
	)
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		user, tokens, err = s.auth.NewGuest(r.Context(), q, name,
			auth.Client{DeviceName: req.GetDeviceName(), IP: httpx.ClientIP(r.Context()), UserAgent: r.UserAgent()})
		if err != nil {
			return err
		}
		added, _, err = grant(r.Context(), q, row, user.ID)
		return err
	})
	if err != nil {
		return err
	}
	s.announce(r.Context(), row, added)
	resp.Tokens, resp.Me = tokens, pbconv.Me(user)
	if auth.IsWeb(r) {
		auth.SetRefreshCookie(w, tokens)
	}
	httpx.Write(w, http.StatusCreated, resp)
	return nil
}

// ---- cleanup ----

// Cleanup removes guest accounts inactive for 7 days: memberships, room overrides, files
// and sessions are deleted; the user row is anonymised ("Гость (удалён)") so that their
// messages stay readable. One instance at a time (advisory lock).
func (s *Service) Cleanup(ctx context.Context) (int, error) {
	now := time.Now()
	ids, err := s.db.Q.ListExpiredGuests(ctx, &now)
	if err != nil || len(ids) == 0 {
		return 0, err
	}
	// One post-commit budget for the whole pass (session revocations and MEMBER_REMOVE of
	// every guest in every workspace): with a hung Redis the pass must not wait 3 s per
	// publish — once the budget is spent, the remaining publishes fail at once.
	ctx = events.WithBudget(ctx, events.RequestBudget)
	n := 0
	for _, uid := range ids {
		if err := s.removeGuest(ctx, uid); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

func (s *Service) removeGuest(ctx context.Context, uid uuid.UUID) error {
	wids, err := s.db.Q.ListUserWorkspaceIDs(ctx, uid)
	if err != nil {
		return err
	}
	var (
		gone     []sqlc.File
		sessions []uuid.UUID
	)
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		// Row lock + re-check: a refresh may have extended the guest since the listing.
		if _, err := q.LockExpiredGuest(ctx, uid); err != nil {
			if db.IsNotFound(err) {
				return errNotExpired
			}
			return err
		}
		files, err := q.ListUserFiles(ctx, uid)
		if err != nil {
			return err
		}
		for _, f := range files {
			n, err := q.DeleteFile(ctx, f.ID)
			if err != nil {
				return err
			}
			if n == 0 {
				continue // removed concurrently (orphan cleanup): its quota is already released
			}
			if f.WorkspaceID != nil {
				if err := q.ReleaseQuota(ctx, sqlc.ReleaseQuotaParams{ID: *f.WorkspaceID, Size: f.Size}); err != nil {
					return err
				}
			}
			gone = append(gone, f)
		}
		if err := q.DeleteUserRoomOverrides(ctx, uid.String()); err != nil {
			return err
		}
		if err := q.DeleteUserMemberships(ctx, uid); err != nil {
			return err
		}
		if sessions, err = q.RevokeAllUserSessions(ctx, uid); err != nil {
			return err
		}
		return q.AnonymizeGuest(ctx, uid)
	})
	if errors.Is(err, errNotExpired) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, f := range gone {
		_ = s.store.Delete(ctx, f.Key)
		if f.ThumbnailKey != nil {
			_ = s.store.Delete(ctx, *f.ThumbnailKey)
		}
	}
	s.auth.MarkRevoked(ctx, sessions...) // access tokens die now, gateway closes with 4010 (own budget)
	for _, w := range wids {
		s.events.Workspace(ctx, w, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberRemove{
			WorkspaceMemberRemove: &v1.WorkspaceMemberRemove{WorkspaceId: w.String(), UserId: uid.String()},
		}})
	}
	return nil
}

var errNotExpired = errors.New("guests: no longer expired")

// RunCleanup runs Cleanup every interval until ctx is done.
func (s *Service) RunCleanup(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := s.Cleanup(ctx); err != nil {
				slog.Error("guest cleanup", "err", err)
			} else if n > 0 {
				slog.Info("inactive guests removed", "count", n)
			}
		}
	}
}
