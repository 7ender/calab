package workspaces

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// Custom workspace roles (ADR-0026, docs/04 «Роли»).

// MaxRoles caps the roles of a workspace, built-ins included.
const MaxRoles = 50

func (h *Handlers) roleRoutes(handle func(string, httpx.HandlerFunc)) {
	handle("GET /api/workspaces/{id}/roles", h.listRoles)
	handle("POST /api/workspaces/{id}/roles", h.createRole)
	handle("PUT /api/workspaces/{id}/roles/order", h.orderRoles)
	handle("PATCH /api/workspaces/{id}/roles/{roleId}", h.updateRole)
	handle("DELETE /api/workspaces/{id}/roles/{roleId}", h.deleteRole)
	handle("PUT /api/workspaces/{id}/members/{userId}/roles", h.setMemberRoles)
}

// roleActor resolves the caller's roles in the workspace {id} (404 for non-members).
func roleActor(r *http.Request) (uuid.UUID, perm.Member, error) {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return uuid.Nil, perm.Member{}, err
	}
	m, err := perm.FromContext(r.Context()).Member(r.Context(), wsID, uid(r))
	if errors.Is(err, perm.ErrNotMember) {
		return uuid.Nil, perm.Member{}, httpx.NotFound("workspace")
	}
	return wsID, m, err
}

// roleManager is roleActor + MANAGE_ROLES.
func roleManager(r *http.Request) (uuid.UUID, perm.Member, error) {
	wsID, m, err := roleActor(r)
	if err != nil {
		return uuid.Nil, perm.Member{}, err
	}
	if !m.Workspace().Has(perm.ManageRoles) {
		return uuid.Nil, perm.Member{}, httpx.Forbidden("MANAGE_ROLES required")
	}
	return wsID, m, nil
}

// above reports whether the actor may act on a role at position pos: it must be below the
// actor's highest role; the owner may act on any role.
func above(actor perm.Member, pos int32) bool {
	return actor.Role == perm.RoleOwner || pos < actor.Top()
}

func validateRoleName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > 32 {
		return "", httpx.Validation("name", "name must be 1..32 characters")
	}
	if strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return "", httpx.Validation("name", "name must not contain control characters")
	}
	return s, nil
}

func validateColor(c uint32) (int32, error) {
	if c > 0xFFFFFF {
		return 0, httpx.Validation("color", "color must be 0..0xFFFFFF")
	}
	return int32(c), nil //nolint:gosec // ≤ 0xFFFFFF
}

// checkGrant validates a role's permissions going from old to next, set by actor (ADR-0026 §3):
// ADMINISTRATOR is never grantable; a non-admin cannot change MANAGE_ROLES / MANAGE_WORKSPACE
// nor any permission they do not hold themselves.
func checkGrant(actor perm.Member, old, next perm.Bits) error {
	if next&^perm.All != 0 {
		return httpx.Validation("permissions", "unknown permission bits")
	}
	if next&perm.Administrator != 0 {
		return httpx.Validation("permissions", "ADMINISTRATOR cannot be given to a role")
	}
	own := actor.Workspace()
	if own.Has(perm.Administrator) {
		return nil
	}
	changed := old ^ next
	if changed&(perm.ManageRoles|perm.ManageWorkspace) != 0 {
		return httpx.Forbidden("only admins can grant or revoke MANAGE_ROLES and MANAGE_WORKSPACE")
	}
	if changed&^own != 0 {
		return httpx.Forbidden("cannot grant or revoke permissions you do not have")
	}
	return nil
}

func (h *Handlers) listRoles(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := roleActor(r)
	if err != nil {
		return err
	}
	rows, err := h.db.Q.ListWorkspaceRoles(r.Context(), wsID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListRolesResponse{Roles: pbconv.Roles(rows)})
	return nil
}

func roleEvent(r sqlc.WorkspaceRole, created bool) *v1.DispatchEvent {
	if created {
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_RoleCreate{RoleCreate: &v1.RoleCreate{Role: pbconv.Role(r)}}}
	}
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_RoleUpdate{RoleUpdate: &v1.RoleUpdate{Role: pbconv.Role(r)}}}
}

func (h *Handlers) createRole(w http.ResponseWriter, r *http.Request) error {
	wsID, actor, err := roleManager(r)
	if err != nil {
		return err
	}
	var req v1.CreateRoleRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := validateRoleName(req.GetName())
	if err != nil {
		return err
	}
	color, err := validateColor(req.GetColor())
	if err != nil {
		return err
	}
	bits := perm.Bits(req.GetPermissions())
	if err := checkGrant(actor, 0, bits); err != nil {
		return err
	}
	if !above(actor, perm.PosCustom) {
		return httpx.Forbidden("cannot create a role above your highest role")
	}
	var (
		created sqlc.WorkspaceRole
		shifted []sqlc.WorkspaceRole
	)
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceRoles(r.Context(), wsID.String()); err != nil {
			return err
		}
		n, err := q.CountWorkspaceRoles(r.Context(), wsID)
		if err != nil {
			return err
		}
		if n >= MaxRoles {
			return httpx.Conflict("a workspace has at most " + strconv.Itoa(MaxRoles) + " roles")
		}
		if shifted, err = q.ShiftCustomRolesUp(r.Context(), wsID); err != nil {
			return err
		}
		created, err = q.CreateRole(r.Context(), sqlc.CreateRoleParams{
			WorkspaceID: wsID, Name: name, Color: color, Position: perm.PosCustom,
			Permissions: int64(bits), Mentionable: req.GetMentionable(), //nolint:gosec // validated bits
		})
		return err
	})
	if err != nil {
		return err
	}
	evs := []*v1.DispatchEvent{roleEvent(created, true)}
	for _, s := range shifted {
		evs = append(evs, roleEvent(s, false))
	}
	h.events.WorkspaceEvents(r.Context(), wsID, evs)
	httpx.Write(w, http.StatusCreated, &v1.CreateRoleResponse{Role: pbconv.Role(created)})
	return nil
}

// loadRole returns the role {roleId} of workspace wsID (404 otherwise).
func loadRole(r *http.Request, q *sqlc.Queries, wsID uuid.UUID) (sqlc.WorkspaceRole, error) {
	id, err := httpx.PathUUID(r, "roleId", "role")
	if err != nil {
		return sqlc.WorkspaceRole{}, err
	}
	role, err := q.GetWorkspaceRole(r.Context(), sqlc.GetWorkspaceRoleParams{ID: id, WorkspaceID: wsID})
	if db.IsNotFound(err) {
		return sqlc.WorkspaceRole{}, httpx.NotFound("role")
	}
	return role, err
}

func builtin(r sqlc.WorkspaceRole) perm.Role {
	if r.Builtin == nil {
		return ""
	}
	return perm.Role(*r.Builtin)
}

func (h *Handlers) updateRole(w http.ResponseWriter, r *http.Request) error {
	wsID, actor, err := roleManager(r)
	if err != nil {
		return err
	}
	var req v1.UpdateRoleRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	var updated sqlc.WorkspaceRole
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceRoles(r.Context(), wsID.String()); err != nil {
			return err
		}
		cur, err := loadRole(r, q, wsID)
		if err != nil {
			return err
		}
		if !above(actor, cur.Position) {
			return httpx.Forbidden("cannot edit a role at or above your highest role")
		}
		b := builtin(cur)
		p := sqlc.UpdateRoleParams{ID: cur.ID, WorkspaceID: wsID, Mentionable: req.Mentionable}
		if req.Name != nil {
			if b != "" {
				return httpx.Validation("name", "built-in roles cannot be renamed")
			}
			n, err := validateRoleName(req.GetName())
			if err != nil {
				return err
			}
			p.Name = &n
		}
		if req.Color != nil {
			c, err := validateColor(req.GetColor())
			if err != nil {
				return err
			}
			p.Color = &c
		}
		if req.Permissions != nil {
			next := perm.Bits(req.GetPermissions())
			old := perm.Bits(uint64(cur.Permissions)) //nolint:gosec // bit mask round-trip
			switch {
			case b == perm.RoleOwner || b == perm.RoleAdmin:
				if next != old {
					return httpx.Validation("permissions", "owner and admin permissions are fixed")
				}
			case b == perm.RoleGuest && next&^perm.GuestMax != 0:
				return httpx.Validation("permissions", "the guest role is limited to viewing, messages, files, voice, streams and cameras")
			}
			if err := checkGrant(actor, old, next); err != nil {
				return err
			}
			v := int64(next) //nolint:gosec // validated bits
			p.Permissions = &v
		}
		updated, err = q.UpdateRole(r.Context(), p)
		return err
	})
	if err != nil {
		return err
	}
	perm.FromContext(r.Context()).Invalidate()
	h.events.Workspace(r.Context(), wsID, roleEvent(updated, false))
	httpx.Write(w, http.StatusOK, &v1.UpdateRoleResponse{Role: pbconv.Role(updated)})
	return nil
}

func (h *Handlers) deleteRole(w http.ResponseWriter, r *http.Request) error {
	wsID, actor, err := roleManager(r)
	if err != nil {
		return err
	}
	var (
		roleID uuid.UUID
		rooms  []uuid.UUID
	)
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceRoles(r.Context(), wsID.String()); err != nil {
			return err
		}
		cur, err := loadRole(r, q, wsID)
		if err != nil {
			return err
		}
		if cur.Builtin != nil {
			return httpx.Validation("roleId", "built-in roles cannot be deleted")
		}
		if !above(actor, cur.Position) {
			return httpx.Forbidden("cannot delete a role at or above your highest role")
		}
		roleID = cur.ID
		// Holders keep their other roles (MEMBER / GUEST at least): member_roles cascade.
		if _, err := q.DeleteRole(r.Context(), sqlc.DeleteRoleParams{ID: cur.ID, WorkspaceID: wsID}); err != nil {
			return err
		}
		rooms, err = q.DeleteRoleOverrides(r.Context(), cur.ID.String())
		return err
	})
	if err != nil {
		return err
	}
	perm.FromContext(r.Context()).Invalidate()
	evs := []*v1.DispatchEvent{{Event: &v1.DispatchEvent_RoleDelete{RoleDelete: &v1.RoleDelete{
		WorkspaceId: wsID.String(), RoleId: roleID.String(),
	}}}}
	slices.SortFunc(rooms, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	for _, rid := range slices.Compact(rooms) {
		ovs, err := h.db.Q.ListRoomOverrides(r.Context(), rid)
		if err != nil {
			return err
		}
		pbs := make([]*v1.RoomPermissionOverride, len(ovs))
		for i, o := range ovs {
			pbs[i] = pbconv.Override(o)
		}
		evs = append(evs, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomPermissionsUpdate{RoomPermissionsUpdate: &v1.RoomPermissionsUpdate{
			WorkspaceId: wsID.String(), RoomId: rid.String(), Permissions: pbs,
		}}})
	}
	h.events.WorkspaceEvents(r.Context(), wsID, evs)
	httpx.NoContent(w)
	return nil
}

func (h *Handlers) orderRoles(w http.ResponseWriter, r *http.Request) error {
	wsID, actor, err := roleManager(r)
	if err != nil {
		return err
	}
	var req v1.SetRoleOrderRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	var (
		all   []sqlc.WorkspaceRole
		moved []sqlc.WorkspaceRole
	)
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceRoles(r.Context(), wsID.String()); err != nil {
			return err
		}
		rows, err := q.ListWorkspaceRoles(r.Context(), wsID)
		if err != nil {
			return err
		}
		custom := map[string]sqlc.WorkspaceRole{}
		for _, rr := range rows {
			if rr.Builtin == nil {
				custom[rr.ID.String()] = rr
			}
		}
		ids := req.GetRoleIds()
		if len(ids) != len(custom) {
			return httpx.Validation("roleIds", "list every custom role exactly once")
		}
		seen := map[string]bool{}
		for i, s := range ids {
			id, err := uuid.Parse(s)
			if err != nil {
				return httpx.Validation("roleIds", "invalid role id")
			}
			cur, ok := custom[id.String()]
			if !ok || seen[id.String()] {
				return httpx.Validation("roleIds", "list every custom role exactly once")
			}
			seen[id.String()] = true
			pos := perm.PosCustom + int32(len(ids)-1-i) //nolint:gosec // ≤ MaxRoles
			if pos == cur.Position {
				continue
			}
			if !above(actor, cur.Position) || !above(actor, pos) {
				return httpx.Forbidden("cannot move roles at or above your highest role")
			}
			nr, err := q.SetRolePosition(r.Context(), sqlc.SetRolePositionParams{ID: cur.ID, WorkspaceID: wsID, Position: pos})
			if err != nil {
				return err
			}
			moved = append(moved, nr)
		}
		all, err = q.ListWorkspaceRoles(r.Context(), wsID)
		return err
	})
	if err != nil {
		return err
	}
	if len(moved) > 0 {
		perm.FromContext(r.Context()).Invalidate()
		evs := make([]*v1.DispatchEvent, len(moved))
		for i, m := range moved {
			evs[i] = roleEvent(m, false)
		}
		h.events.WorkspaceEvents(r.Context(), wsID, evs)
	}
	httpx.Write(w, http.StatusOK, &v1.SetRoleOrderResponse{Roles: pbconv.Roles(all)})
	return nil
}

// legacyRole is workspace_members.role for a set of built-in roles: the highest one.
func legacyRole(has func(perm.Role) bool, base perm.Role) perm.Role {
	switch {
	case has(perm.RoleOwner):
		return perm.RoleOwner
	case has(perm.RoleAdmin):
		return perm.RoleAdmin
	}
	return base
}

func (h *Handlers) setMemberRoles(w http.ResponseWriter, r *http.Request) error {
	wsID, actor, err := roleManager(r)
	if err != nil {
		return err
	}
	target, err := targetUser(r)
	if err != nil {
		return err
	}
	var req v1.SetMemberRolesRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	want := map[uuid.UUID]bool{}
	for _, s := range req.GetRoleIds() {
		id, err := uuid.Parse(s)
		if err != nil {
			return httpx.Validation("roleIds", "invalid role id")
		}
		want[id] = true
	}
	var m sqlc.WorkspaceMember
	changed := false
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceRoles(r.Context(), wsID.String()); err != nil {
			return err
		}
		var err error
		m, err = q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: wsID, UserID: target})
		if db.IsNotFound(err) {
			return httpx.NotFound("member")
		}
		if err != nil {
			return err
		}
		rows, err := q.ListWorkspaceRoles(r.Context(), wsID)
		if err != nil {
			return err
		}
		byID := make(map[uuid.UUID]sqlc.WorkspaceRole, len(rows))
		for _, rr := range rows {
			byID[rr.ID] = rr
		}
		for id := range want {
			if _, ok := byID[id]; !ok {
				return httpx.Validation("roleIds", "unknown role")
			}
		}
		curIDs, err := q.ListMemberRoleIDs(r.Context(), sqlc.ListMemberRoleIDsParams{WorkspaceID: wsID, UserID: target})
		if err != nil {
			return err
		}
		cur := map[uuid.UUID]bool{}
		top := int32(-1)
		for _, id := range curIDs {
			cur[id] = true
			top = max(top, byID[id].Position)
		}
		if target != uid(r) && !above(actor, top) {
			return httpx.Forbidden("cannot change the roles of a member at or above your highest role")
		}
		base := perm.RoleMember
		if perm.Role(m.Role) == perm.RoleGuest {
			base = perm.RoleGuest
		}
		// The base role (MEMBER / GUEST) is kept whether listed or not; the other one cannot
		// be added here (guest → member is POST …/promote).
		for id, rr := range byID {
			switch builtin(rr) {
			case base:
				want[id] = true
			case perm.RoleMember, perm.RoleGuest:
				if want[id] {
					return httpx.Validation("roleIds", "use POST …/members/{userId}/promote to make a guest a member")
				}
			}
		}
		own := actor.Workspace()
		var add, remove []uuid.UUID
		for id, rr := range byID {
			if want[id] == cur[id] {
				continue
			}
			switch b := builtin(rr); {
			case b == perm.RoleOwner:
				return httpx.Forbidden("ownership cannot be changed here")
			case b == perm.RoleAdmin && actor.Role != perm.RoleOwner:
				return httpx.Forbidden("only the owner can grant or revoke admin")
			case b == perm.RoleAdmin && perm.Role(m.Role) == perm.RoleOwner:
				return httpx.Validation("roleIds", "the owner has full access already")
			case b == perm.RoleAdmin && base == perm.RoleGuest:
				return httpx.Validation("roleIds", "promote the guest to a member first")
			case !above(actor, rr.Position):
				return httpx.Forbidden("cannot assign roles at or above your highest role")
			case !own.Has(perm.Administrator) && perm.Bits(uint64(rr.Permissions))&^own != 0: //nolint:gosec // bit mask
				return httpx.Forbidden("cannot assign a role with permissions you do not have")
			}
			if want[id] {
				add = append(add, id)
			} else {
				remove = append(remove, id)
			}
		}
		if len(add)+len(remove) == 0 {
			return nil
		}
		changed = true
		// Built-in roles follow workspace_members.role (trigger, migration 00021).
		hasBuiltin := func(b perm.Role) bool {
			for id, rr := range byID {
				if builtin(rr) == b {
					return want[id]
				}
			}
			return false
		}
		if next := legacyRole(hasBuiltin, base); next != perm.Role(m.Role) {
			s := string(next)
			if m, err = q.UpdateMember(r.Context(), sqlc.UpdateMemberParams{WorkspaceID: wsID, UserID: target, Role: &s}); err != nil {
				return err
			}
		}
		for _, id := range add {
			if builtin(byID[id]) == "" {
				if err := q.AddMemberRole(r.Context(), sqlc.AddMemberRoleParams{WorkspaceID: wsID, UserID: target, RoleID: id}); err != nil {
					return err
				}
			}
		}
		for _, id := range remove {
			if builtin(byID[id]) == "" {
				if err := q.RemoveMemberRole(r.Context(), sqlc.RemoveMemberRoleParams{WorkspaceID: wsID, UserID: target, RoleID: id}); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	pb, err := h.memberPB(r.Context(), m)
	if err != nil {
		return err
	}
	if changed {
		perm.FromContext(r.Context()).Invalidate()
		h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberUpdate{
			WorkspaceMemberUpdate: &v1.WorkspaceMemberUpdate{Member: pb},
		}})
	}
	httpx.Write(w, http.StatusOK, &v1.SetMemberRolesResponse{Member: pb})
	return nil
}

func (h *Handlers) memberPB(ctx context.Context, m sqlc.WorkspaceMember) (*v1.WorkspaceMember, error) {
	u, err := h.db.Q.GetUser(ctx, m.UserID)
	if err != nil {
		return nil, err
	}
	return MemberPB(ctx, h.db.Q, m, u)
}
