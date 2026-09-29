package calendar

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// The calendar side of the CalDAV push (ADR-0041 §4): who is told about a change, and what
// a user's calendar should hold for a meeting now.

// changed tells Changed about the members involved in any of the states of one meeting
// (before and after a change: removed attendees get the meeting deleted).
func (s *Service) changed(ctx context.Context, states ...*bundle) {
	if s.Changed == nil {
		return
	}
	var id uuid.UUID
	seen := map[uuid.UUID]bool{}
	var users []uuid.UUID
	add := func(u uuid.UUID) {
		if !seen[u] {
			seen[u] = true
			users = append(users, u)
		}
	}
	for _, b := range states {
		if b == nil {
			continue
		}
		id = b.ev.ID
		add(b.ev.OrganizerID)
		for _, a := range b.att {
			if a.UserID != nil {
				add(*a.UserID)
			}
		}
	}
	if id != uuid.Nil {
		s.Changed(ctx, id, users)
	}
}

// EventForCalDAV returns the .ics the user's CalDAV calendar should hold for the meeting —
// the invitation's VEVENT without METHOD, ORGANIZER and ATTENDEE lines (a CalDAV server that
// schedules would mail the attendees again) — or live = false when it should not be there:
// the meeting is gone or cancelled, the user declined it, left it or the workspace.
func (s *Service) EventForCalDAV(ctx context.Context, eventID, user uuid.UUID) (ics string, live bool, err error) {
	ev, err := s.db.Q.GetEvent(ctx, eventID)
	if db.IsNotFound(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if ev.CancelledAt != nil {
		return "", false, nil
	}
	b, err := loadOne(ctx, s.db.Q, ev)
	if err != nil {
		return "", false, err
	}
	if !busyIn(b, user) {
		return "", false, nil
	}
	members, err := s.db.Q.ListFreeBusyMembers(ctx, sqlc.ListFreeBusyMembersParams{WorkspaceID: ev.WorkspaceID, Ids: []uuid.UUID{user}})
	if err != nil {
		return "", false, err
	}
	if len(members) == 0 {
		return "", false, nil
	}
	e := ICSEvent{UID: ev.ID.String() + "@calab", Sequence: int(ev.Sequence), Series: b.series, Title: ev.Title,
		Description: ev.Description, URL: s.eventURL(ev.ID), Stamp: s.Now()}
	if ev.RoomID != nil {
		if r, err := s.db.Q.GetRoom(ctx, *ev.RoomID); err == nil {
			e.Location = "Calab: " + r.Name
		}
	}
	return BuildICS(e), true, nil
}

// UserEventIDs lists the meetings the user organizes or attends (not declined) that have an
// occurrence in the coming year: pushed when the push is turned on.
func (s *Service) UserEventIDs(ctx context.Context, user uuid.UUID) ([]uuid.UUID, error) {
	now := s.Now()
	evs, err := s.db.Q.ListUserEvents(ctx, sqlc.ListUserEventsParams{UserID: user, From: &now, To: now.Add(365 * 24 * time.Hour)})
	if err != nil {
		return nil, err
	}
	bs, err := load(ctx, s.db.Q, evs)
	if err != nil {
		return nil, err
	}
	var out []uuid.UUID
	for _, b := range bs {
		if busyIn(b, user) {
			out = append(out, b.ev.ID)
		}
	}
	return out, nil
}
