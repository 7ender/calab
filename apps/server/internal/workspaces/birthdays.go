package workspaces

import (
	"net/http"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/birthdays"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/profile"
)

// birthdayRoutes: members' birthdays set by an admin (docs/09 #77).
func (h *Handlers) birthdayRoutes(handle func(string, httpx.HandlerFunc)) {
	handle("GET /api/workspaces/{id}/members/birthdays", h.listMemberBirthdays)
	handle("PATCH /api/workspaces/{id}/members/{userId}/birthday", h.setMemberBirthday)
}

// birthdayManager: the caller's workspace, with MANAGE_NICKNAMES (the right to others'
// nicknames covers the other profile field an admin may set).
func birthdayManager(r *http.Request) (uuid.UUID, error) {
	wsID, bits, _, err := access(r)
	if err != nil {
		return uuid.Nil, err
	}
	if !bits.Has(perm.ManageNicknames) {
		return uuid.Nil, httpx.Forbidden("MANAGE_NICKNAMES required")
	}
	return wsID, nil
}

func memberBirthday(id uuid.UUID, day, month, year *int16, hidden bool) *v1.MemberBirthday {
	return &v1.MemberBirthday{UserId: id.String(), Birthday: pbconv.Birthday(day, month, year), Hidden: hidden}
}

// listMemberBirthdays: GET /api/workspaces/{id}/members/birthdays — hidden ones included.
func (h *Handlers) listMemberBirthdays(w http.ResponseWriter, r *http.Request) error {
	wsID, err := birthdayManager(r)
	if err != nil {
		return err
	}
	rows, err := h.db.Q.ListMemberBirthdays(r.Context(), wsID)
	if err != nil {
		return err
	}
	out := &v1.ListMemberBirthdaysResponse{Birthdays: make([]*v1.MemberBirthday, 0, len(rows))}
	for _, row := range rows {
		out.Birthdays = append(out.Birthdays, memberBirthday(row.ID, row.BirthdayDay, row.BirthdayMonth, row.BirthdayYear, row.BirthdayHidden))
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// setMemberBirthday: PATCH /api/workspaces/{id}/members/{userId}/birthday. The member's
// "hidden" flag is theirs and stays untouched.
func (h *Handlers) setMemberBirthday(w http.ResponseWriter, r *http.Request) error {
	wsID, err := birthdayManager(r)
	if err != nil {
		return err
	}
	target, err := targetUser(r)
	if err != nil {
		return err
	}
	var req v1.UpdateMemberBirthdayRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	cur, err := h.db.Q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: wsID, UserID: target})
	if db.IsNotFound(err) {
		return httpx.NotFound("member")
	}
	if err != nil {
		return err
	}
	if perm.Role(cur.Role) == perm.RoleGuest {
		return httpx.Forbidden("guests have no birthday") // as PATCH /api/me (ADR-0016)
	}
	tu, err := h.db.Q.GetUser(r.Context(), target)
	if err != nil {
		return err
	}
	if tu.IsBot {
		return httpx.Forbidden("bots have no birthday") // ADR-0031
	}
	if target != uid(r) {
		if err := outranks(r, wsID, target); err != nil {
			return err
		}
	}
	p := sqlc.UpdateUserParams{ID: target, SetBirthday: true}
	if p.BirthdayDay, p.BirthdayMonth, p.BirthdayYear, err = birthdays.Columns(req.GetBirthday(), time.Now()); err != nil {
		return err
	}
	u, err := h.db.Q.UpdateUser(r.Context(), p)
	if err != nil {
		return err
	}
	// Me to the member, User (without a hidden birthday) to their workspaces.
	profile.Publish(r.Context(), h.db.Q, h.events, u, true)
	httpx.Write(w, http.StatusOK, &v1.UpdateMemberBirthdayResponse{
		Birthday: memberBirthday(u.ID, u.BirthdayDay, u.BirthdayMonth, u.BirthdayYear, u.BirthdayHidden),
	})
	return nil
}
