package bots

import (
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// ADR-0051: which workspace events reach bots by webhook, and meetings without addresses.
func TestWorkspaceView(t *testing.T) {
	wid := uuid.MustParse("01890000-0000-7000-8000-000000000001")
	for name, ev := range map[string]*v1.DispatchEvent{
		"task":   {Event: &v1.DispatchEvent_TaskCreate{TaskCreate: &v1.TaskCreate{Task: &v1.Task{BoardId: wid.String()}}}},
		"member": {Event: &v1.DispatchEvent_WorkspaceMemberUpdate{WorkspaceMemberUpdate: &v1.WorkspaceMemberUpdate{}}},
		"event":  {Event: &v1.DispatchEvent_EventCreate{EventCreate: &v1.CalendarEventCreate{Event: &v1.CalendarEvent{}}}},
		"rsvp":   {Event: &v1.DispatchEvent_EventRsvp{EventRsvp: &v1.CalendarEventRsvp{Event: &v1.CalendarEvent{}}}},
	} {
		if workspaceView(wid, ev) == nil {
			t.Errorf("%s: not delivered by webhook", name)
		}
	}
	if workspaceView(wid, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceAppDelete{WorkspaceAppDelete: &v1.WorkspaceAppDelete{}}}) != nil {
		t.Error("web apps (ADR-0050) are not for bots")
	}
	// The organizing bot gets the meeting as is; a meeting without a room reaches nobody else.
	org := uuid.MustParse("01890000-0000-7000-8000-000000000002")
	ev := &v1.DispatchEvent{Event: &v1.DispatchEvent_EventCreate{EventCreate: &v1.CalendarEventCreate{Event: &v1.CalendarEvent{
		OrganizerId: org.String(), Attendees: []*v1.CalendarEventAttendee{{Email: "x@outside.org"}}}}}}
	view := calendarView(wid, ev)
	if view(t.Context(), nil, org) != ev || view(t.Context(), nil, wid) != nil {
		t.Error("calendar view: organizer / meeting without a room")
	}
	rsvp := &v1.DispatchEvent{Event: &v1.DispatchEvent_EventRsvp{EventRsvp: &v1.CalendarEventRsvp{
		Attendee: &v1.CalendarEventAttendee{Email: "x@outside.org"},
		Event:    &v1.CalendarEvent{Attendees: []*v1.CalendarEventAttendee{{Email: "x@outside.org"}}}}}}
	for _, e := range []*v1.DispatchEvent{ev, rsvp} {
		out := eventWithoutEmails(e)
		c := out.GetEventCreate().GetEvent()
		if c == nil {
			c = out.GetEventRsvp().GetEvent()
			if out.GetEventRsvp().GetAttendee().GetEmail() != "" {
				t.Error("the RSVP attendee keeps the address")
			}
		}
		if c.GetAttendees()[0].GetEmail() != "" {
			t.Errorf("address kept: %v", c)
		}
	}
	if ev.GetEventCreate().GetEvent().GetAttendees()[0].GetEmail() == "" {
		t.Error("eventWithoutEmails changed its argument")
	}
}
