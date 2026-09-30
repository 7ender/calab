package guests

// Guest admission, the «waiting room» of room links (ADR-0040). A guest arriving by a link
// that requires approval becomes a `guest` member without the room's override and knocks
// (room_admissions, pending); a decider — INVITE_GUESTS in the room, or the author of the link —
// admits (the override is written as the link would have) or declines. Nobody answering
// within 30 minutes declines the knock (the sweeper, every 30 s).

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/profile"
	"github.com/calaba/calaba/server/internal/workspaces"
)

const (
	// MaxPendingAdmissions caps the knocks waiting on one room (more → 429).
	MaxPendingAdmissions = 50
	// PendingTTL is how long a knock waits: one nobody answers is declined after this long.
	PendingTTL = 30 * time.Minute
	// DeclineHold is how long a declined knock is kept; after a decline by a person the guest
	// may not knock again before it runs out.
	DeclineHold = 10 * time.Minute
	// AdmissionSweep is how often the sweeper runs.
	AdmissionSweep = 30 * time.Second
	// maxGuestName: the name a decider gives a guest (users.display_name of a guest account).
	maxGuestName = 40

	statusPending  = "pending"
	statusDeclined = "declined"
)

// ApiError.reason of 429 on a knock: declined by a person within DeclineHold, or the room
// already has MaxPendingAdmissions knocks waiting.
const (
	ReasonAdmissionDeclined  = "ADMISSION_DECLINED"
	ReasonAdmissionQueueFull = "ADMISSION_QUEUE_FULL"
)

// RequiresApproval returns the link's own setting, else the room's (NULL inherits).
func RequiresApproval(room bool, link *bool) bool {
	if link != nil {
		return *link
	}
	return room
}

// declineHolds reports whether a declined knock still refuses a new one at now: only a
// decline by a person holds (nobody answering lets the guest knock again at once).
func declineHolds(a sqlc.RoomAdmission, now time.Time) bool {
	return a.Status == statusDeclined && a.DecidedBy != nil && a.DecidedAt != nil && now.Sub(*a.DecidedAt) < DeclineHold
}

// staleBefore: pending knocks requested before it are declined by the sweeper.
func staleBefore(now time.Time) time.Time { return now.Add(-PendingTTL) }

// expiredBefore: declined knocks decided before it are deleted.
func expiredBefore(now time.Time) time.Time { return now.Add(-DeclineHold) }

func statusPB(st string) v1.RoomAdmissionStatus {
	switch st {
	case statusPending:
		return v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_PENDING
	case statusDeclined:
		return v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_DECLINED
	case "admitted":
		return v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_ADMITTED
	}
	return v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_UNSPECIFIED
}

func idOrEmpty(id *uuid.UUID) string {
	if id == nil {
		return ""
	}
	return id.String()
}

// admissionPB is the deciders' view of a knock.
func admissionPB(a sqlc.RoomAdmission, wsID uuid.UUID, u sqlc.User, inviteBy *uuid.UUID) *v1.RoomAdmission {
	out := &v1.RoomAdmission{
		RoomId: a.RoomID.String(), WorkspaceId: wsID.String(), User: pbconv.User(u),
		InviteId: idOrEmpty(a.InviteID), InviteCreatedBy: idOrEmpty(inviteBy),
		Status: statusPB(a.Status), RequestedAt: timestamppb.New(a.RequestedAt), DecidedBy: idOrEmpty(a.DecidedBy),
		NoAnswer: a.Status == statusDeclined && a.DecidedBy == nil,
	}
	if a.DecidedAt != nil {
		out.DecidedAt = timestamppb.New(*a.DecidedAt)
	}
	return out
}

// guestView is the guest's own view of a knock: no link author, the user by id only, and the
// names for the waiting screen.
func guestView(a sqlc.RoomAdmission, wsID uuid.UUID, roomName, wsName string) *v1.RoomAdmission {
	out := &v1.RoomAdmission{
		RoomId: a.RoomID.String(), WorkspaceId: wsID.String(), User: &v1.User{Id: a.UserID.String()},
		InviteId: idOrEmpty(a.InviteID), Status: statusPB(a.Status), RequestedAt: timestamppb.New(a.RequestedAt),
		DecidedBy: idOrEmpty(a.DecidedBy), NoAnswer: a.Status == statusDeclined && a.DecidedBy == nil,
		RoomName: roomName, WorkspaceName: wsName,
	}
	if a.DecidedAt != nil {
		out.DecidedAt = timestamppb.New(*a.DecidedAt)
	}
	return out
}

// OwnAdmissions returns the user's knocks for READY (pending, and declined ones still kept).
func OwnAdmissions(ctx context.Context, q *sqlc.Queries, userID uuid.UUID) ([]*v1.RoomAdmission, error) {
	rows, err := q.ListUserAdmissions(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]*v1.RoomAdmission, 0, len(rows))
	for _, r := range rows {
		if r.WorkspaceID == nil {
			continue
		}
		out = append(out, guestView(r.RoomAdmission, *r.WorkspaceID, r.RoomName, r.WorkspaceName))
	}
	return out, nil
}

// FillAdmissions adds to each snapshot of a READY the pending knocks the recipient decides:
// on rooms where they hold INVITE_GUESTS (Permissions of the snapshot), or by their links.
func FillAdmissions(ctx context.Context, q *sqlc.Queries, userID uuid.UUID, snaps []*v1.WorkspaceSnapshot) error {
	if len(snaps) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, 0, len(snaps))
	byWS := make(map[uuid.UUID]*v1.WorkspaceSnapshot, len(snaps))
	for _, sn := range snaps {
		if sn.GetRole() == v1.WorkspaceRole_WORKSPACE_ROLE_GUEST {
			continue // guests decide nothing
		}
		id, err := uuid.Parse(sn.GetWorkspace().GetId())
		if err != nil {
			continue
		}
		ids = append(ids, id)
		byWS[id] = sn
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.ListWorkspacesPendingAdmissions(ctx, ids)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if r.WorkspaceID == nil {
			continue
		}
		sn := byWS[*r.WorkspaceID]
		if sn == nil {
			continue
		}
		bits := perm.Bits(sn.GetPermissions()[r.RoomAdmission.RoomID.String()])
		if bits.Has(perm.InviteGuests) || (r.InviteCreatedBy != nil && *r.InviteCreatedBy == userID) {
			sn.Admissions = append(sn.Admissions, admissionPB(r.RoomAdmission, *r.WorkspaceID, r.User, r.InviteCreatedBy))
		}
	}
	return nil
}

// knock records a pending knock of userID inside the join transaction (the membership as
// `guest` is made by the caller). A knock already pending is returned as is (fresh=false).
func (s *Service) knock(ctx context.Context, q *sqlc.Queries, row sqlc.GetRoomInviteByCodeRow, userID uuid.UUID) (adm sqlc.RoomAdmission, fresh bool, err error) {
	roomID, now := row.Room.ID, time.Now()
	if err := q.LockRoomAdmissions(ctx, roomID); err != nil {
		return adm, false, err
	}
	cur, err := q.GetAdmissionForUpdate(ctx, sqlc.GetAdmissionForUpdateParams{RoomID: roomID, UserID: userID})
	switch {
	case err == nil && cur.Status == statusPending:
		return cur, false, nil // knocking again while waiting (a reload): nothing changes
	case err == nil && declineHolds(cur, now):
		return adm, false, httpx.RateLimited().WithDetails(ReasonAdmissionDeclined, 0, 0)
	case err != nil && !db.IsNotFound(err):
		return adm, false, err
	}
	n, err := q.CountPendingAdmissions(ctx, roomID)
	if err != nil {
		return adm, false, err
	}
	if n >= MaxPendingAdmissions {
		return adm, false, httpx.RateLimited().WithDetails(ReasonAdmissionQueueFull, uint64(n), MaxPendingAdmissions) //nolint:gosec // n ≥ 50
	}
	adm, err = q.UpsertPendingAdmission(ctx, sqlc.UpsertPendingAdmissionParams{
		RoomID: roomID, UserID: userID, InviteID: &row.RoomInvite.ID, RequestedAt: now,
	})
	return adm, err == nil, err
}

// announceKnock tells the deciders about a new knock.
func (s *Service) announceKnock(ctx context.Context, row sqlc.GetRoomInviteByCodeRow, adm sqlc.RoomAdmission) {
	u, err := s.db.Q.GetUser(ctx, adm.UserID)
	if err != nil {
		slog.WarnContext(ctx, "admission request event", "err", err)
		return
	}
	by := row.RoomInvite.CreatedBy
	s.events.Workspace(ctx, row.Workspace.ID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomAdmissionRequest{
		RoomAdmissionRequest: &v1.RoomAdmissionRequest{Admission: admissionPB(adm, row.Workspace.ID, u, &by)},
	}})
}

// publishDecided sends ROOM_ADMISSION_DECIDED to the deciders (workspace channel, routed by
// the gateway) and to the guest's devices.
func (s *Service) publishDecided(ctx context.Context, a sqlc.RoomAdmission, status v1.RoomAdmissionStatus, room sqlc.Room, wsName string, inviteBy *uuid.UUID) {
	if room.WorkspaceID == nil {
		return
	}
	wsID := *room.WorkspaceID
	dv := admissionPB(a, wsID, sqlc.User{ID: a.UserID}, inviteBy)
	dv.User = &v1.User{Id: a.UserID.String()}
	dv.Status = status
	s.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomAdmissionDecided{
		RoomAdmissionDecided: &v1.RoomAdmissionDecided{Admission: dv},
	}})
	gv := guestView(a, wsID, room.Name, wsName)
	gv.Status = status
	s.events.User(ctx, a.UserID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomAdmissionDecided{
		RoomAdmissionDecided: &v1.RoomAdmissionDecided{Admission: gv},
	}})
}

// dropIdleGuest removes a guest membership that no longer has a room (no personal override in
// another room, no other pending knock) inside q. Returns whether it was removed.
func dropIdleGuest(ctx context.Context, q *sqlc.Queries, wsID, roomID, userID uuid.UUID) (bool, error) {
	keep, err := q.GuestHasOtherAccess(ctx, sqlc.GuestHasOtherAccessParams{WorkspaceID: wsID, RoomID: roomID, UserID: userID})
	if err != nil || keep {
		return false, err
	}
	n, err := q.RemoveGuestMember(ctx, sqlc.RemoveGuestMemberParams{WorkspaceID: wsID, UserID: userID})
	if err != nil || n == 0 {
		return false, err
	}
	return true, q.DeleteUserOverridesInWorkspace(ctx, sqlc.DeleteUserOverridesInWorkspaceParams{WorkspaceID: wsID, UserID: userID.String()})
}

// publishRemoved announces a guest membership dropped with its last knock.
func (s *Service) publishRemoved(ctx context.Context, wsID, userID uuid.UUID) {
	s.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberRemove{
		WorkspaceMemberRemove: &v1.WorkspaceMemberRemove{WorkspaceId: wsID.String(), UserId: userID.String()},
	}})
	s.events.User(ctx, userID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceDelete{
		WorkspaceDelete: &v1.WorkspaceDelete{WorkspaceId: wsID.String()},
	}})
}

// publishOverrides sends the room's overrides after one of them changed.
func (s *Service) publishOverrides(ctx context.Context, wsID, roomID uuid.UUID) {
	ovs, err := s.db.Q.ListRoomOverrides(ctx, roomID)
	if err != nil {
		slog.WarnContext(ctx, "room overrides event", "err", err)
		return
	}
	pbs := make([]*v1.RoomPermissionOverride, len(ovs))
	for i, o := range ovs {
		pbs[i] = pbconv.Override(o)
	}
	s.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomPermissionsUpdate{
		RoomPermissionsUpdate: &v1.RoomPermissionsUpdate{WorkspaceId: wsID.String(), RoomId: roomID.String(), Permissions: pbs},
	}})
}

// decider checks that the caller may decide on knocks of roomID: INVITE_GUESTS there, or (when
// inviteBy is the caller) the author of the link, still a member of the workspace.
type decider struct {
	caller uuid.UUID
	acc    perm.RoomAccess
	manage bool
}

func loadDecider(r *http.Request, roomID uuid.UUID) (decider, error) {
	caller := auth.MustFromContext(r.Context()).UserID
	acc, err := perm.FromContext(r.Context()).Room(r.Context(), roomID, caller)
	if errors.Is(err, perm.ErrNoRoom) || (err == nil && acc.DM) {
		return decider{}, httpx.NotFound("room")
	}
	if err != nil {
		return decider{}, err
	}
	return decider{caller: caller, acc: acc, manage: acc.Role != perm.RoleGuest && acc.Bits.Has(perm.InviteGuests)}, nil
}

func (d decider) may(inviteBy *uuid.UUID) bool {
	return d.manage || (inviteBy != nil && *inviteBy == d.caller && d.acc.Role != perm.RoleGuest)
}

// listAdmissions: GET /api/rooms/{id}/admissions.
func (s *Service) listAdmissions(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	d, err := loadDecider(r, roomID)
	if err != nil {
		return err
	}
	if !d.manage {
		// Without INVITE_GUESTS only the author of a link of the room decides (on its knocks).
		n, err := s.db.Q.CountUserRoomInvites(r.Context(), sqlc.CountUserRoomInvitesParams{RoomID: roomID, CreatedBy: d.caller})
		if err != nil {
			return err
		}
		if n == 0 || d.acc.Role == perm.RoleGuest {
			if !d.acc.Bits.Has(perm.ViewRoom) {
				return httpx.NotFound("room")
			}
			return httpx.Forbidden("INVITE_GUESTS required")
		}
	}
	rows, err := s.db.Q.ListRoomPendingAdmissions(r.Context(), roomID)
	if err != nil {
		return err
	}
	out := &v1.ListRoomAdmissionsResponse{Admissions: []*v1.RoomAdmission{}}
	for _, row := range rows {
		if d.may(row.InviteCreatedBy) {
			out.Admissions = append(out.Admissions, admissionPB(row.RoomAdmission, d.acc.WorkspaceID, row.User, row.InviteCreatedBy))
		}
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// guestName validates the name a decider gives a guest: 1..40 characters after trimming.
func guestName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > maxGuestName {
		return "", httpx.Validation("displayName", "name must be 1..40 characters")
	}
	return s, nil
}

// decide: POST /api/rooms/{id}/admissions/{userId}.
func (s *Service) decide(w http.ResponseWriter, r *http.Request) error {
	if auth.IsBotRequest(r) {
		return auth.ErrBotNotAllowed
	}
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	target, err := httpx.PathUUID(r, "userId", "admission")
	if err != nil {
		return err
	}
	var req v1.DecideRoomAdmissionRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	admit := req.GetStatus() == v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_ADMITTED
	if !admit && req.GetStatus() != v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_DECLINED {
		return httpx.Validation("status", "status must be ADMITTED or DECLINED")
	}
	var name *string
	if req.DisplayName != nil && admit {
		n, err := guestName(req.GetDisplayName())
		if err != nil {
			return err
		}
		name = &n
	}
	d, err := loadDecider(r, roomID)
	if err != nil {
		return err
	}
	wsID := d.acc.WorkspaceID
	var badge *uuid.UUID
	setBadge := req.BadgeId != nil && admit
	if setBadge && req.GetBadgeId() != "" {
		id, err := uuid.Parse(req.GetBadgeId())
		if err != nil {
			return httpx.Validation("badgeId", "unknown badge")
		}
		badge = &id
	}
	var (
		adm      sqlc.RoomAdmission
		room     sqlc.Room
		inviteBy *uuid.UUID
		renamed  *sqlc.User
		member   *sqlc.WorkspaceMember
		removed  bool
	)
	now := time.Now()
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		adm, err = q.GetAdmissionForUpdate(r.Context(), sqlc.GetAdmissionForUpdateParams{RoomID: roomID, UserID: target})
		if db.IsNotFound(err) {
			if d.manage {
				return httpx.NotFound("admission")
			}
			return httpx.Forbidden("INVITE_GUESTS required")
		}
		if err != nil {
			return err
		}
		var inv *sqlc.RoomInvite
		if adm.InviteID != nil {
			i, err := q.GetRoomInvite(r.Context(), *adm.InviteID)
			if err != nil && !db.IsNotFound(err) {
				return err
			}
			if err == nil {
				inv, inviteBy = &i, &i.CreatedBy
			}
		}
		if !d.may(inviteBy) {
			return httpx.Forbidden("INVITE_GUESTS required")
		}
		if adm.Status != statusPending {
			return httpx.Conflict("the knock is no longer pending")
		}
		if room, err = q.GetRoom(r.Context(), roomID); err != nil {
			if db.IsNotFound(err) {
				return httpx.NotFound("room")
			}
			return err
		}
		if !admit {
			if adm, err = q.DeclineAdmission(r.Context(), sqlc.DeclineAdmissionParams{RoomID: roomID, UserID: target, DecidedBy: &d.caller, DecidedAt: now}); err != nil {
				return err
			}
			if adm.InviteID != nil {
				if err := q.RefundRoomInviteUse(r.Context(), *adm.InviteID); err != nil {
					return err
				}
			}
			removed, err = dropIdleGuest(r.Context(), q, wsID, roomID, target)
			return err
		}
		if err := moderation.CheckSuspended(r.Context(), q, wsID); err != nil {
			return err
		}
		if _, err := q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: wsID, UserID: target}); err != nil {
			if db.IsNotFound(err) {
				return httpx.Conflict("the guest is no longer in the workspace")
			}
			return err
		}
		bits := int64(AllowBits(true, true, false, false)) //nolint:gosec // bit mask: a default link, when the link is gone
		if inv != nil {
			bits = inv.AllowBits
		}
		if _, err := q.UpsertUserOverride(r.Context(), sqlc.UpsertUserOverrideParams{RoomID: roomID, UserID: target.String(), Allow: bits}); err != nil {
			return err
		}
		if _, err := q.DeleteAdmission(r.Context(), sqlc.DeleteAdmissionParams{RoomID: roomID, UserID: target}); err != nil {
			return err
		}
		adm.DecidedBy, adm.DecidedAt = &d.caller, &now
		if name != nil {
			u, err := q.SetGuestDisplayName(r.Context(), sqlc.SetGuestDisplayNameParams{ID: target, DisplayName: *name})
			if db.IsNotFound(err) {
				return httpx.Validation("displayName", "only a guest account can be renamed")
			}
			if err != nil {
				return err
			}
			renamed = &u
		}
		if setBadge {
			if badge != nil {
				if _, err := q.GetWorkspaceBadge(r.Context(), sqlc.GetWorkspaceBadgeParams{ID: *badge, WorkspaceID: wsID}); err != nil {
					if db.IsNotFound(err) {
						return httpx.Validation("badgeId", "unknown badge")
					}
					return err
				}
			}
			m, err := q.SetMemberBadge(r.Context(), sqlc.SetMemberBadgeParams{WorkspaceID: wsID, UserID: target, BadgeID: badge})
			if err != nil {
				return err
			}
			member = &m
		}
		return nil
	})
	if err != nil {
		return err
	}
	perm.FromContext(r.Context()).Invalidate()
	wsName := ""
	if ws, err := s.db.Q.GetWorkspace(r.Context(), wsID); err == nil {
		wsName = ws.Name
	}
	status := v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_DECLINED
	if admit {
		status = v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_ADMITTED
		if renamed != nil {
			profile.Publish(r.Context(), s.db.Q, s.events, *renamed, true)
		}
		if member != nil {
			if u, err := s.db.Q.GetUser(r.Context(), target); err == nil {
				if pb, err := workspaces.MemberPB(r.Context(), s.db.Q, *member, u); err == nil {
					s.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberUpdate{
						WorkspaceMemberUpdate: &v1.WorkspaceMemberUpdate{Member: pb}}})
				}
			}
		}
		// The guest gets the room as with a link without approval: ROOM_CREATE from the
		// gateway on the override change (and rtc may grant from now on).
		s.publishOverrides(r.Context(), wsID, roomID)
	}
	s.publishDecided(r.Context(), adm, status, room, wsName, inviteBy)
	if removed {
		s.publishRemoved(r.Context(), wsID, target)
	}
	u, err := s.db.Q.GetUser(r.Context(), target)
	if err != nil {
		return err
	}
	out := admissionPB(adm, wsID, u, inviteBy)
	out.Status = status
	httpx.Write(w, http.StatusOK, &v1.DecideRoomAdmissionResponse{Admission: out})
	return nil
}

// cancelAdmission: DELETE /api/rooms/{id}/admissions/me — the guest stops waiting.
func (s *Service) cancelAdmission(w http.ResponseWriter, r *http.Request) error {
	if auth.IsBotRequest(r) {
		return auth.ErrBotNotAllowed
	}
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	me := auth.MustFromContext(r.Context()).UserID
	var (
		adm      sqlc.RoomAdmission
		room     sqlc.Room
		inviteBy *uuid.UUID
		removed  bool
	)
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		adm, err = q.GetAdmissionForUpdate(r.Context(), sqlc.GetAdmissionForUpdateParams{RoomID: roomID, UserID: me})
		if db.IsNotFound(err) || (err == nil && adm.Status != statusPending) {
			return httpx.NotFound("admission")
		}
		if err != nil {
			return err
		}
		if room, err = q.GetRoom(r.Context(), roomID); err != nil {
			if db.IsNotFound(err) {
				return httpx.NotFound("admission")
			}
			return err
		}
		if room.WorkspaceID == nil {
			return httpx.NotFound("admission")
		}
		if _, err := q.DeleteAdmission(r.Context(), sqlc.DeleteAdmissionParams{RoomID: roomID, UserID: me}); err != nil {
			return err
		}
		if adm.InviteID != nil {
			if i, err := q.GetRoomInvite(r.Context(), *adm.InviteID); err == nil {
				inviteBy = &i.CreatedBy
			}
			if err := q.RefundRoomInviteUse(r.Context(), *adm.InviteID); err != nil {
				return err
			}
		}
		removed, err = dropIdleGuest(r.Context(), q, *room.WorkspaceID, roomID, me)
		return err
	})
	if err != nil {
		return err
	}
	wsID := *room.WorkspaceID
	wsName := ""
	if ws, err := s.db.Q.GetWorkspace(r.Context(), wsID); err == nil {
		wsName = ws.Name
	}
	s.publishDecided(r.Context(), adm, v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_CANCELLED, room, wsName, inviteBy)
	if removed {
		s.publishRemoved(r.Context(), wsID, me)
	}
	httpx.NoContent(w)
	return nil
}

// SweepAdmissions declines knocks nobody answered within PendingTTL (the guest sees «no
// answer») and deletes declines older than DeclineHold. Returns how many were declined.
// Safe on several instances: each stale row is taken by one of them (SKIP LOCKED).
func (s *Service) SweepAdmissions(ctx context.Context) (int, error) {
	return s.SweepAdmissionsAt(ctx, time.Now())
}

// SweepAdmissionsAt is SweepAdmissions with the clock at now (tests).
func (s *Service) SweepAdmissionsAt(ctx context.Context, now time.Time) (int, error) {
	ctx = events.WithBudget(ctx, events.RequestBudget)
	stale, err := s.db.Q.DeclineStaleAdmissions(ctx, sqlc.DeclineStaleAdmissionsParams{Now: now, Cutoff: staleBefore(now)})
	if err != nil {
		return 0, err
	}
	for _, a := range stale {
		if err := s.afterNoAnswer(ctx, a); err != nil {
			slog.WarnContext(ctx, "admission sweep", "room", a.RoomID, "user", a.UserID, "err", err)
		}
	}
	if _, err := s.db.Q.DeleteExpiredDeclines(ctx, expiredBefore(now)); err != nil {
		return len(stale), err
	}
	return len(stale), nil
}

func (s *Service) afterNoAnswer(ctx context.Context, a sqlc.RoomAdmission) error {
	room, err := s.db.Q.GetRoom(ctx, a.RoomID)
	if db.IsNotFound(err) || (err == nil && room.WorkspaceID == nil) {
		return nil // the room went meanwhile
	}
	if err != nil {
		return err
	}
	wsID := *room.WorkspaceID
	var (
		inviteBy *uuid.UUID
		removed  bool
	)
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a.InviteID != nil {
			if i, err := q.GetRoomInvite(ctx, *a.InviteID); err == nil {
				inviteBy = &i.CreatedBy
			}
			if err := q.RefundRoomInviteUse(ctx, *a.InviteID); err != nil {
				return err
			}
		}
		var err error
		removed, err = dropIdleGuest(ctx, q, wsID, a.RoomID, a.UserID)
		return err
	})
	if err != nil {
		return err
	}
	wsName := ""
	if ws, err := s.db.Q.GetWorkspace(ctx, wsID); err == nil {
		wsName = ws.Name
	}
	s.publishDecided(ctx, a, v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_DECLINED, room, wsName, inviteBy)
	if removed {
		s.publishRemoved(ctx, wsID, a.UserID)
	}
	return nil
}

// RunAdmissions runs SweepAdmissions every interval until ctx is done.
func (s *Service) RunAdmissions(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := s.SweepAdmissions(ctx); err != nil {
				slog.Error("admission sweep", "err", err)
			} else if n > 0 {
				slog.Info("unanswered guest knocks declined", "count", n)
			}
		}
	}
}
