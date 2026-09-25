package gateway

import (
	"context"
	"sync"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// wsState is this instance's view of one workspace: all live rooms (with overrides) and
// member roles. It is loaded from Postgres once and then kept current by applying the
// workspace's events in order, so per-recipient VIEW_ROOM filtering needs no DB queries.
type wsState struct {
	mu      sync.RWMutex
	loading bool
	backlog []pendingEvent // events received while loading
	ws      *v1.Workspace
	rooms   map[uuid.UUID]*v1.Room
	targets map[uuid.UUID][]perm.OverrideTarget // parsed overrides per room (M13: once per change, not per check)
	roles   map[uuid.UUID]perm.Role
}

// setRoom stores a room and its parsed overrides (mu held).
func (s *wsState) setRoom(id uuid.UUID, r *v1.Room) {
	if s.targets == nil {
		s.targets = map[uuid.UUID][]perm.OverrideTarget{}
	}
	s.rooms[id] = r
	s.targets[id] = pbconv.ProtoOverrideTargets(r.GetPermissionOverrides())
}

func (s *wsState) delRoom(id uuid.UUID) {
	delete(s.rooms, id)
	delete(s.targets, id)
}

// coRoom reports whether a and b can both view at least one common room (mu held):
// what a guest may see of another member (ADR-0016, security review M7).
func (s *wsState) coRoom(a, b uuid.UUID) bool {
	for id := range s.rooms {
		if s.bits(id, a).Has(perm.ViewRoom) && s.bits(id, b).Has(perm.ViewRoom) {
			return true
		}
	}
	return false
}

// guestVisible returns the members a guest may see (mu held).
func (s *wsState) guestVisible(guest uuid.UUID) map[uuid.UUID]bool {
	out := map[uuid.UUID]bool{guest: true}
	for u := range s.roles {
		if u != guest && s.coRoom(guest, u) {
			out[u] = true
		}
	}
	return out
}

// hiddenFrom reports whether events about subject must not reach viewer: only guests are
// restricted, to members who share a room with them.
func (s *wsState) hiddenFrom(viewer, subject uuid.UUID) bool {
	if viewer == subject || s.roles[viewer] != perm.RoleGuest {
		return false
	}
	return !s.coRoom(viewer, subject)
}

func loadState(ctx context.Context, q *sqlc.Queries, wid uuid.UUID) (*wsState, error) {
	ws, err := q.GetWorkspace(ctx, wid)
	if err != nil {
		return nil, err
	}
	rs, err := q.ListRooms(ctx, wid)
	if err != nil {
		return nil, err
	}
	ovs, err := q.ListWorkspaceRoomOverrides(ctx, wid)
	if err != nil {
		return nil, err
	}
	roles, err := q.ListMemberRoles(ctx, wid)
	if err != nil {
		return nil, err
	}
	byRoom := map[uuid.UUID][]sqlc.RoomPermission{}
	for _, o := range ovs {
		byRoom[o.RoomID] = append(byRoom[o.RoomID], o)
	}
	st := &wsState{ws: pbconv.Workspace(ws), rooms: map[uuid.UUID]*v1.Room{}, roles: map[uuid.UUID]perm.Role{}}
	defaults := pbconv.WorkspaceDefaults(ws)
	for _, r := range rs {
		st.setRoom(r.ID, pbconv.Room(r, defaults, byRoom[r.ID]))
	}
	for _, m := range roles {
		st.roles[m.UserID] = perm.Role(m.Role)
	}
	return st, nil
}

// roomBits returns userID's permissions in room (0 if not a member).
func roomBits(room *v1.Room, role perm.Role, userID uuid.UUID) perm.Bits {
	if room == nil || role == "" {
		return 0
	}
	return perm.ComputeIn(role, userID.String(), pbconv.ProtoOverrideTargets(room.GetPermissionOverrides()))
}

// bits must be called with mu held (read).
func (s *wsState) bits(roomID, userID uuid.UUID) perm.Bits {
	role := s.roles[userID]
	if role == "" || s.rooms[roomID] == nil {
		return 0
	}
	if t, ok := s.targets[roomID]; ok {
		return perm.ComputeIn(role, userID.String(), t)
	}
	return roomBits(s.rooms[roomID], role, userID)
}

func (s *wsState) canView(roomID, userID uuid.UUID) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.bits(roomID, userID).Has(perm.ViewRoom)
}

// transition turns a room change for one recipient into the events that recipient should
// see: both visible → changed (the original event), gained → ROOM_CREATE, lost → ROOM_DELETE.
func transition(before, after bool, changed *v1.DispatchEvent, room *v1.Room, wid, rid uuid.UUID) *v1.DispatchEvent {
	switch {
	case before && after:
		return changed
	case !before && after:
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomCreate{RoomCreate: &v1.RoomCreate{Room: room}}}
	case before && !after:
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomDelete{RoomDelete: &v1.RoomDelete{WorkspaceId: wid.String(), RoomId: rid.String()}}}
	}
	return nil
}

// withPermissions returns a copy of room with new overrides.
func withPermissions(room *v1.Room, ovs []*v1.RoomPermissionOverride) *v1.Room {
	c := proto.Clone(room).(*v1.Room)
	c.PermissionOverrides = ovs
	return c
}

// sanitizeVoice hides the room of a voice state the recipient cannot see (the user then
// appears not to be in voice at all).
func sanitizeVoice(vs *v1.VoiceState, visible func(uuid.UUID) bool) *v1.VoiceState {
	rid, err := uuid.Parse(vs.GetRoomId())
	if err != nil || visible(rid) {
		return vs
	}
	return &v1.VoiceState{WorkspaceId: vs.GetWorkspaceId(), UserId: vs.GetUserId()}
}
