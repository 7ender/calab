package calendar

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// Free / busy and finding a time (ADR-0041 §1, §2, §5). Only the fact of being busy is
// shared: a meeting's id goes out only when the caller may see it in this workspace.

// allDaySlack widens the queried window: an all-day meeting of another zone lands on the
// same calendar days of the person's zone, up to ~26 h apart.
const allDaySlack = 27 * time.Hour

// busyItem is one busy interval of a person.
type busyItem struct {
	occ     Occurrence
	eventID string
	kind    v1.BusyKind
	allDay  bool
}

// busyPerson is a member asked about.
type busyPerson struct {
	id   uuid.UUID
	tz   string
	loc  *time.Location
	work WorkHours
	row  sqlc.ListFreeBusyMembersRow
	busy []busyItem
}

var errNoCommonHours = &httpx.Error{Status: http.StatusConflict, Code: v1.ErrorCode_ERROR_CODE_NO_COMMON_HOURS,
	Message: "the working hours of these people do not intersect in this window; try without «within working hours»"}

// busyViewer resolves the caller: a member, not a guest (403) and not a bot (403).
func busyViewer(r *http.Request, wsID uuid.UUID, q *sqlc.Queries) (*viewer, error) {
	if auth.MustFromContext(r.Context()).IsBot {
		return nil, auth.ErrBotNotAllowed
	}
	return requestViewer(r, wsID, q)
}

func parseUserIDs(raw []string) ([]uuid.UUID, error) {
	var ids []uuid.UUID
	for _, s := range raw {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		id, err := uuid.Parse(s)
		if err != nil {
			return nil, httpx.Validation("users", "users are member ids")
		}
		if !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 || len(ids) > MaxBusyUsers {
		return nil, httpx.Validation("users", "1 to 20 people")
	}
	return ids, nil
}

func checkWindow(from, to time.Time) error {
	if !to.After(from) || to.Sub(from) > MaxBusyWindow {
		return httpx.Validation("to", "to must be after from, at most 14 days later")
	}
	return nil
}

// people loads the asked members in the order of ids: 422 when one is not a member (or a
// guest, a bot, disabled).
func (s *Service) people(ctx context.Context, wsID uuid.UUID, ids []uuid.UUID) ([]*busyPerson, error) {
	rows, err := s.db.Q.ListFreeBusyMembers(ctx, sqlc.ListFreeBusyMembersParams{WorkspaceID: wsID, Ids: ids})
	if err != nil {
		return nil, err
	}
	byID := make(map[uuid.UUID]sqlc.ListFreeBusyMembersRow, len(rows))
	for _, r := range rows {
		byID[r.ID] = r
	}
	out := make([]*busyPerson, 0, len(ids))
	for _, id := range ids {
		r, ok := byID[id]
		if !ok {
			return nil, httpx.Validation("users", "users must be members of the workspace (not guests or bots)")
		}
		tz := "UTC"
		if r.Timezone != nil && *r.Timezone != "" {
			if _, err := time.LoadLocation(*r.Timezone); err == nil {
				tz = *r.Timezone
			}
		}
		loc := loadZone(tz)
		days := make([]int, 0, len(r.WorkDays))
		for _, d := range r.WorkDays {
			days = append(days, int(d))
		}
		out = append(out, &busyPerson{id: id, tz: tz, loc: loc, row: r,
			work: WorkHours{Start: int(r.WorkStartMin), End: int(r.WorkEndMin), Days: days, Loc: loc}})
	}
	return out, nil
}

// collectBusy fills the busy intervals of people overlapping [from, to): their meetings (any
// workspace; declined ones do not count, the organizer is always busy) and the imported
// external busy time. v decides which meeting ids of wsID may be shown.
func (s *Service) collectBusy(ctx context.Context, v *viewer, wsID uuid.UUID, people []*busyPerson, from, to time.Time) error {
	ids := make([]uuid.UUID, len(people))
	for i, p := range people {
		ids[i] = p.id
	}
	qFrom, qTo := from.Add(-allDaySlack), to.Add(allDaySlack)
	evs, err := s.db.Q.ListBusyEvents(ctx, sqlc.ListBusyEventsParams{Ids: ids, From: &qFrom, To: qTo})
	if err != nil {
		return err
	}
	bs, err := load(ctx, s.db.Q, evs)
	if err != nil {
		return err
	}
	for _, b := range bs {
		occs := b.series.Between(qFrom, qTo)
		if len(occs) == 0 {
			continue
		}
		visible := ""
		if b.ev.WorkspaceID == wsID && v.sees(b) {
			visible = b.ev.ID.String()
		}
		for _, p := range people {
			if !busyIn(b, p.id) {
				continue
			}
			for _, o := range occs {
				if b.ev.AllDay {
					o = AllDayIn(o, b.series.Loc, p.loc)
				}
				if o.End.After(from) && o.Start.Before(to) {
					p.busy = append(p.busy, busyItem{occ: o, eventID: visible, kind: v1.BusyKind_BUSY_KIND_MEETING, allDay: b.ev.AllDay})
				}
			}
		}
	}
	ext, err := s.db.Q.ListExternalBusy(ctx, sqlc.ListExternalBusyParams{Ids: ids, From: from, To: to})
	if err != nil {
		return err
	}
	byID := make(map[uuid.UUID]*busyPerson, len(people))
	for _, p := range people {
		byID[p.id] = p
	}
	for _, e := range ext {
		if p := byID[e.UserID]; p != nil {
			p.busy = append(p.busy, busyItem{occ: Occurrence{e.StartsAt, e.EndsAt}, kind: v1.BusyKind_BUSY_KIND_EXTERNAL, allDay: e.AllDay})
		}
	}
	for _, p := range people {
		slices.SortStableFunc(p.busy, func(a, b busyItem) int {
			if c := a.occ.Start.Compare(b.occ.Start); c != 0 {
				return c
			}
			return a.occ.End.Compare(b.occ.End)
		})
	}
	return nil
}

// busyIn: the user organizes the meeting, or attends it with an answer other than declined.
func busyIn(b *bundle, user uuid.UUID) bool {
	if b.ev.OrganizerID == user {
		return true
	}
	a, ok := b.attendee(user)
	return ok && a.Status != StatusDeclined
}

// freeBusy: GET /api/workspaces/{id}/freebusy?users&from&to.
func (s *Service) freeBusy(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	v, err := busyViewer(r, wsID, s.db.Q)
	if err != nil {
		return err
	}
	qs := r.URL.Query()
	ids, err := parseUserIDs(strings.Split(strings.Join(qs["users"], ","), ","))
	if err != nil {
		return err
	}
	from, err1 := time.Parse(time.RFC3339, qs.Get("from"))
	to, err2 := time.Parse(time.RFC3339, qs.Get("to"))
	if err1 != nil || err2 != nil {
		return httpx.Validation("from", "from and to are RFC 3339 times")
	}
	if err := checkWindow(from, to); err != nil {
		return err
	}
	if s.FreeBusyLimit != nil {
		if err := s.FreeBusyLimit.Take(ctx, v.user.String()); err != nil {
			return err
		}
	}
	people, err := s.people(ctx, wsID, ids)
	if err != nil {
		return err
	}
	if err := s.collectBusy(ctx, v, wsID, people, from, to); err != nil {
		return err
	}
	out := &v1.FreeBusyResponse{Users: make([]*v1.FreeBusyUser, 0, len(people))}
	for _, p := range people {
		u := &v1.FreeBusyUser{UserId: p.id.String(), Timezone: p.tz,
			WorkHours: WorkHoursProto(p.row.WorkStartMin, p.row.WorkEndMin, p.row.WorkDays), Busy: make([]*v1.BusyInterval, 0, len(p.busy))}
		for _, b := range p.busy {
			u.Busy = append(u.Busy, &v1.BusyInterval{StartsAt: timestamppb.New(b.occ.Start), EndsAt: timestamppb.New(b.occ.End),
				EventId: b.eventID, Kind: b.kind, AllDay: b.allDay})
		}
		out.Users = append(out.Users, u)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// suggest: POST /api/workspaces/{id}/freebusy/suggest.
func (s *Service) suggest(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	v, err := busyViewer(r, wsID, s.db.Q)
	if err != nil {
		return err
	}
	var req v1.SuggestSlotsRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	ids, err := parseUserIDs(req.GetUsers())
	if err != nil {
		return err
	}
	if d := req.GetDurationMin(); d < MinSlotDuration || d > MaxSlotDuration {
		return httpx.Validation("durationMin", "duration is 5..1440 minutes")
	}
	if req.GetFrom() == nil || req.GetTo() == nil {
		return httpx.Validation("from", "from and to are required")
	}
	from, to := tsTime(req.GetFrom()), tsTime(req.GetTo())
	if err := checkWindow(from, to); err != nil {
		return err
	}
	var room *uuid.UUID
	if req.GetRoomId() != "" {
		rid, err := uuid.Parse(req.GetRoomId())
		if err != nil || !v.rooms[rid].Has(perm.ViewRoom) {
			return httpx.Validation("roomId", "no such room in this workspace")
		}
		room = &rid
	}
	if s.SuggestLimit != nil {
		if err := s.SuggestLimit.Take(ctx, v.user.String()); err != nil {
			return err
		}
	}
	people, err := s.people(ctx, wsID, ids)
	if err != nil {
		return err
	}
	if now := s.Now(); from.Before(now) {
		from = now
	}
	out := &v1.SuggestSlotsResponse{Slots: []*v1.Slot{}}
	if !to.After(from) {
		httpx.Write(w, http.StatusOK, out)
		return nil
	}
	var allowed []Occurrence
	if req.GetWithinWorkHours() {
		allowed = Merge(people[0].work.Intervals(from, to))
		for _, p := range people[1:] {
			allowed = Intersect(allowed, Merge(p.work.Intervals(from, to)))
		}
		if len(allowed) == 0 {
			return errNoCommonHours
		}
	}
	if err := s.collectBusy(ctx, v, wsID, people, from, to); err != nil {
		return err
	}
	var busy []Occurrence
	for _, p := range people {
		for _, b := range p.busy {
			busy = append(busy, b.occ)
		}
	}
	if room != nil {
		occ, err := s.roomBusy(ctx, *room, from, to)
		if err != nil {
			return err
		}
		busy = append(busy, occ...)
	}
	slots := FindSlots(SlotQuery{From: from, To: to, Duration: time.Duration(req.GetDurationMin()) * time.Minute,
		Busy: busy, Allowed: allowed, Limit: MaxSuggestions})
	for _, sl := range slots {
		out.Slots = append(out.Slots, &v1.Slot{StartsAt: timestamppb.New(sl.Start), EndsAt: timestamppb.New(sl.End)})
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// roomBusy: occurrences of the room's meetings overlapping [from, to).
func (s *Service) roomBusy(ctx context.Context, room uuid.UUID, from, to time.Time) ([]Occurrence, error) {
	evs, err := s.db.Q.ListRoomBusyEvents(ctx, sqlc.ListRoomBusyEventsParams{RoomID: &room, From: &from, To: to})
	if err != nil {
		return nil, err
	}
	bs, err := load(ctx, s.db.Q, evs)
	if err != nil {
		return nil, err
	}
	var out []Occurrence
	for _, b := range bs {
		out = append(out, b.series.Between(from, to)...)
	}
	return out, nil
}
