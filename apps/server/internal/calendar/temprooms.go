package calendar

import (
	"context"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// Temporary rooms (ADR-0044): the meeting of a new temporary room, and closing a room's
// meetings when the room is archived. Implements rooms.Meetings.

// CreateRoomMeeting inserts a one-off meeting of roomID from start to end, organized by
// organizer (the only attendee, accepted), inside the caller's transaction q. publish announces
// it after the commit (EVENT_CREATE, the room badge, the organizer's CalDAV push); no mail —
// the organizer made it.
func (s *Service) CreateRoomMeeting(ctx context.Context, q *sqlc.Queries, wsID, organizer, roomID uuid.UUID, title string, start, end time.Time) (*v1.CalendarEvent, func(context.Context), error) {
	ev, err := q.InsertEvent(ctx, sqlc.InsertEventParams{
		WorkspaceID: wsID, RoomID: &roomID, Title: title, StartsAt: start.UTC(), EndsAt: end.UTC(),
		Tz: s.userZone(ctx, organizer), OrganizerID: organizer,
	})
	if err != nil {
		return nil, nil, err
	}
	now := s.Now()
	if err := insertAttendee(ctx, q, ev.ID, wantAttendee{user: &organizer, required: true}, StatusAccepted, &now); err != nil {
		return nil, nil, err
	}
	b, err := loadOne(ctx, q, ev)
	if err != nil {
		return nil, nil, err
	}
	publish := func(ctx context.Context) {
		s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventCreate{EventCreate: &v1.CalendarEventCreate{Event: b.proto(nil, nil)}}})
		s.roomSignals(ctx, nil, b)
		s.changed(ctx, b)
	}
	return b.proto(nil, nil), publish, nil
}

// CloseRoomMeetings runs inside the transaction that archives roomID: its one-off meetings
// that are running end now, those not started yet are cancelled (their guest links revoked).
// Series are left alone (a series booked into a room outlives one closing). publish announces
// the changes after the commit, as a manual change or cancellation would (EVENT_UPDATE /
// EVENT_DELETE, room badge, mail to attendees, CalDAV push).
func (s *Service) CloseRoomMeetings(ctx context.Context, q *sqlc.Queries, roomID uuid.UUID) (func(context.Context), error) {
	now := s.Now()
	evs, err := q.ListRoomLiveEvents(ctx, sqlc.ListRoomLiveEventsParams{RoomID: &roomID, Now: now})
	if err != nil || len(evs) == 0 {
		return func(context.Context) {}, err
	}
	type change struct {
		before, after *bundle
		cancelled     bool
	}
	var changes []change
	for _, ev := range evs {
		before, err := loadOne(ctx, q, ev)
		if err != nil {
			return nil, err
		}
		var after sqlc.Event
		cancelled := !ev.StartsAt.Before(now)
		if cancelled {
			after, err = q.CancelEvent(ctx, ev.ID)
			if err == nil {
				err = q.RevokeEventRoomInvites(ctx, sqlc.RevokeEventRoomInvitesParams{EventID: &ev.ID})
			}
		} else {
			after, err = q.EndEventAt(ctx, sqlc.EndEventAtParams{ID: ev.ID, At: now})
		}
		if err != nil {
			return nil, err
		}
		ab, err := loadOne(ctx, q, after)
		if err != nil {
			return nil, err
		}
		changes = append(changes, change{before: before, after: ab, cancelled: cancelled})
	}
	return func(ctx context.Context) {
		for _, c := range changes {
			wsID := c.after.ev.WorkspaceID
			if c.cancelled {
				s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventDelete{EventDelete: &v1.CalendarEventDelete{Event: c.after.proto(nil, nil)}}})
				s.roomSignals(ctx, c.before, nil)
				s.sendMails(ctx, c.after, mail.TemplateEventCancel, MethodCancel, c.after.att)
			} else {
				s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventUpdate{EventUpdate: &v1.CalendarEventUpdate{Event: c.after.proto(nil, nil)}}})
				s.roomSignals(ctx, c.before, c.after)
				s.sendMails(ctx, c.after, mail.TemplateEventUpdate, MethodRequest, c.after.att)
			}
			s.changed(ctx, c.before, c.after)
		}
	}, nil
}

// FollowRoomExpiry runs inside the transaction that moves a temporary room's end: its one-off
// meetings that ended with the room (ends_at = oldEnd) move to newEnd, others stay. publish
// announces the changes after the commit as a manual edit would (EVENT_UPDATE, room badge,
// mail to attendees, CalDAV push).
func (s *Service) FollowRoomExpiry(ctx context.Context, q *sqlc.Queries, roomID uuid.UUID, oldEnd, newEnd time.Time) (func(context.Context), error) {
	evs, err := q.FollowRoomExpiryEvents(ctx, sqlc.FollowRoomExpiryEventsParams{RoomID: &roomID, EndsAt: newEnd.UTC(), OldEndsAt: oldEnd.UTC()})
	if err != nil || len(evs) == 0 {
		return func(context.Context) {}, err
	}
	type change struct{ before, after *bundle }
	var changes []change
	for _, ev := range evs {
		after, err := loadOne(ctx, q, ev)
		if err != nil {
			return nil, err
		}
		prev := ev
		prev.EndsAt, prev.Sequence = oldEnd.UTC(), ev.Sequence-1
		before, err := loadOne(ctx, q, prev)
		if err != nil {
			return nil, err
		}
		changes = append(changes, change{before: before, after: after})
	}
	return func(ctx context.Context) {
		for _, c := range changes {
			s.ev.Workspace(ctx, c.after.ev.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventUpdate{EventUpdate: &v1.CalendarEventUpdate{Event: c.after.proto(nil, nil)}}})
			s.roomSignals(ctx, c.before, c.after)
			s.sendMails(ctx, c.after, mail.TemplateEventUpdate, MethodRequest, c.after.att)
			s.changed(ctx, c.before, c.after)
		}
	}, nil
}
