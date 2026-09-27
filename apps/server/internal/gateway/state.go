package gateway

import (
	"context"
	"slices"
	"sync"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// wsState is this instance's view of one workspace: all live rooms (with overrides), the
// roles (ADR-0026) and every member's roles. It is loaded from Postgres once and then kept
// current by applying the workspace's events in order, so per-recipient VIEW_ROOM filtering
// needs no DB queries.
type wsState struct {
	mu       sync.RWMutex
	loading  bool
	backlog  []pendingEvent // events received while loading
	ws       *v1.Workspace
	rooms    map[uuid.UUID]*v1.Room
	targets  map[uuid.UUID][]perm.OverrideTarget // parsed overrides per room (M13: once per change, not per check)
	roleDefs perm.Roles                          // role id -> position / permissions
	roleIDs  map[uuid.UUID][]string              // member -> role ids
	members  map[uuid.UUID]perm.Member           // derived from roleIDs + roleDefs
	// viewers caches who can view each room, for guest visibility (review B2). Filled lazily
	// and only under the write lock (the fan-out path); dropped per room by setRoom/delRoom
	// and entirely by member and role changes.
	viewers map[uuid.UUID]map[uuid.UUID]bool
}

// setMember stores a member's built-in role and role ids (mu held).
func (s *wsState) setMember(uid uuid.UUID, role perm.Role, ids []string) {
	if s.roleIDs == nil {
		s.roleIDs = map[uuid.UUID][]string{}
	}
	if s.members == nil {
		s.members = map[uuid.UUID]perm.Member{}
	}
	s.roleIDs[uid] = ids
	s.members[uid] = s.roleDefs.Member(uid.String(), role, ids)
	s.viewers = nil
}

func (s *wsState) delMember(uid uuid.UUID) {
	if _, ok := s.members[uid]; ok {
		delete(s.members, uid)
		delete(s.roleIDs, uid)
		s.viewers = nil
	}
}

// role returns a member's highest built-in role ("" = not a member).
func (s *wsState) role(uid uuid.UUID) perm.Role { return s.members[uid].Role }

// setRoleDef stores a created / updated role and rebuilds its holders (mu held).
func (s *wsState) setRoleDef(r *v1.Role) {
	if s.roleDefs == nil {
		s.roleDefs = perm.Roles{}
	}
	s.roleDefs[r.GetId()] = perm.RoleBits{ID: r.GetId(), Position: r.GetPosition(), Permissions: perm.Bits(r.GetPermissions())}
	s.rebuild()
}

// delRoleDef forgets a deleted role, also in every member's role ids (mu held).
func (s *wsState) delRoleDef(id string) {
	delete(s.roleDefs, id)
	for u, ids := range s.roleIDs {
		if slices.Contains(ids, id) {
			s.roleIDs[u] = slices.DeleteFunc(slices.Clone(ids), func(x string) bool { return x == id })
		}
	}
	s.rebuild()
}

func (s *wsState) rebuild() {
	for u, m := range s.members {
		s.members[u] = s.roleDefs.Member(m.UserID, m.Role, s.roleIDs[u])
	}
	s.viewers = nil
}

// roomViewers returns the members who can view room id (mu held for write).
func (s *wsState) roomViewers(id uuid.UUID) map[uuid.UUID]bool {
	if v, ok := s.viewers[id]; ok {
		return v
	}
	v := map[uuid.UUID]bool{}
	for u := range s.members {
		if s.bits(id, u).Has(perm.ViewRoom) {
			v[u] = true
		}
	}
	if s.viewers == nil {
		s.viewers = map[uuid.UUID]map[uuid.UUID]bool{}
	}
	s.viewers[id] = v
	return v
}

// setRoom stores a room and its parsed overrides (mu held).
func (s *wsState) setRoom(id uuid.UUID, r *v1.Room) {
	if s.targets == nil {
		s.targets = map[uuid.UUID][]perm.OverrideTarget{}
	}
	s.rooms[id] = r
	s.targets[id] = pbconv.ProtoOverrideTargets(r.GetPermissionOverrides())
	delete(s.viewers, id)
}

func (s *wsState) delRoom(id uuid.UUID) {
	delete(s.rooms, id)
	delete(s.targets, id)
	delete(s.viewers, id)
}

// coRoom reports whether a and b can both view at least one common room (mu held for
// write): what a guest may see of another member (ADR-0016, security review M7).
func (s *wsState) coRoom(a, b uuid.UUID) bool {
	for id := range s.rooms {
		if v := s.roomViewers(id); v[a] && v[b] {
			return true
		}
	}
	return false
}

// guestVisible returns the members a guest may see (mu held for write).
func (s *wsState) guestVisible(guest uuid.UUID) map[uuid.UUID]bool {
	out := map[uuid.UUID]bool{guest: true}
	for id := range s.rooms {
		if v := s.roomViewers(id); v[guest] {
			for u := range v {
				out[u] = true
			}
		}
	}
	return out
}

// sameVisibility reports whether replacing room id with r cannot change who sees what:
// the room exists and keeps its overrides and category (review B2).
func (s *wsState) sameVisibility(id uuid.UUID, r *v1.Room) bool {
	old := s.rooms[id]
	if old == nil || old.GetCategoryId() != r.GetCategoryId() || len(old.GetPermissionOverrides()) != len(r.GetPermissionOverrides()) {
		return false
	}
	for i, o := range old.GetPermissionOverrides() {
		if !proto.Equal(o, r.GetPermissionOverrides()[i]) {
			return false
		}
	}
	return true
}

// hiddenFrom reports whether events about subject must not reach viewer: only guests are
// restricted, to members who share a room with them (mu held for write).
func (s *wsState) hiddenFrom(viewer, subject uuid.UUID) bool {
	if viewer == subject || s.role(viewer) != perm.RoleGuest {
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
	roles, err := q.ListWorkspaceRoles(ctx, wid)
	if err != nil {
		return nil, err
	}
	members, err := q.ListWorkspaceMemberRoles(ctx, wid)
	if err != nil {
		return nil, err
	}
	byRoom := map[uuid.UUID][]sqlc.RoomPermission{}
	for _, o := range ovs {
		byRoom[o.RoomID] = append(byRoom[o.RoomID], o)
	}
	st := &wsState{ws: pbconv.Workspace(ws), rooms: map[uuid.UUID]*v1.Room{}, roleDefs: perm.RolesOf(roles)}
	defaults := pbconv.WorkspaceDefaults(ws)
	for _, r := range rs {
		st.setRoom(r.ID, pbconv.Room(r, defaults, byRoom[r.ID]))
	}
	for _, m := range members {
		st.setMember(m.UserID, perm.Role(m.Role), perm.IDStrings(m.RoleIds))
	}
	return st, nil
}

// bits must be called with mu held (read).
func (s *wsState) bits(roomID, userID uuid.UUID) perm.Bits {
	m, ok := s.members[userID]
	if !ok || s.rooms[roomID] == nil {
		return 0
	}
	t, ok := s.targets[roomID]
	if !ok {
		t = pbconv.ProtoOverrideTargets(s.rooms[roomID].GetPermissionOverrides())
	}
	return perm.ComputeIn(m, t)
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
