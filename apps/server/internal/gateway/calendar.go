package gateway

import (
	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// routeCalendar delivers the calendar events of a workspace (ADR-0038) as each recipient
// should see them (st.mu held). EVENT_* go to the organizer, the attendees and the viewers of
// the meeting's room, never to guests; ROOM_EVENT_* to the room's viewers, guests included
// (without attendees, ADR-0038 «Диплинки для приглашённых»). External attendees'
// addresses are in full for those involved and those who may edit the meeting, masked for other
// viewers and removed for bots.
func (h *Hub) routeCalendar(st *wsState, sessions []*Session, view func(rid, uid uuid.UUID) bool, id uuid.UUID, ev *v1.DispatchEvent) {
	var e *v1.CalendarEvent
	roomOnly := false
	wrap := func(*v1.CalendarEvent, pbconv.EmailView) *v1.DispatchEvent { return ev }
	switch x := ev.GetEvent().(type) {
	case *v1.DispatchEvent_EventCreate:
		e = x.EventCreate.GetEvent()
		wrap = func(c *v1.CalendarEvent, _ pbconv.EmailView) *v1.DispatchEvent {
			return &v1.DispatchEvent{Event: &v1.DispatchEvent_EventCreate{EventCreate: &v1.CalendarEventCreate{Event: c}}}
		}
	case *v1.DispatchEvent_EventUpdate:
		e = x.EventUpdate.GetEvent()
		wrap = func(c *v1.CalendarEvent, _ pbconv.EmailView) *v1.DispatchEvent {
			return &v1.DispatchEvent{Event: &v1.DispatchEvent_EventUpdate{EventUpdate: &v1.CalendarEventUpdate{Event: c}}}
		}
	case *v1.DispatchEvent_EventDelete:
		e = x.EventDelete.GetEvent()
		wrap = func(c *v1.CalendarEvent, _ pbconv.EmailView) *v1.DispatchEvent {
			return &v1.DispatchEvent{Event: &v1.DispatchEvent_EventDelete{EventDelete: &v1.CalendarEventDelete{Event: c}}}
		}
	case *v1.DispatchEvent_EventRsvp:
		e = x.EventRsvp.GetEvent()
		wrap = func(c *v1.CalendarEvent, v pbconv.EmailView) *v1.DispatchEvent {
			r := x.EventRsvp
			a := pbconv.EventForViewer(&v1.CalendarEvent{Attendees: []*v1.CalendarEventAttendee{r.GetAttendee()}}, v).GetAttendees()[0]
			return &v1.DispatchEvent{Event: &v1.DispatchEvent_EventRsvp{EventRsvp: &v1.CalendarEventRsvp{
				WorkspaceId: r.GetWorkspaceId(), EventId: r.GetEventId(), Attendee: a, Counts: r.GetCounts(), Event: c}}}
		}
	case *v1.DispatchEvent_RoomEventActive:
		e, roomOnly = x.RoomEventActive.GetEvent(), true
		wrap = func(c *v1.CalendarEvent, _ pbconv.EmailView) *v1.DispatchEvent {
			return &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomEventActive{RoomEventActive: &v1.RoomEventActive{
				WorkspaceId: x.RoomEventActive.GetWorkspaceId(), RoomId: x.RoomEventActive.GetRoomId(), Event: c}}}
		}
	case *v1.DispatchEvent_RoomEventEnded:
		rid := parseID(x.RoomEventEnded.GetRoomId())
		shared := newEnc(ev)
		for _, s := range sessions {
			if view(rid, s.user) {
				s.dispatchEnc(id, shared)
			}
		}
		return
	}
	var guestEnc *encEvent // ROOM_EVENT_ACTIVE for guests: without attendees
	guest := func() *encEvent {
		if guestEnc == nil {
			guestEnc = newEnc(wrap(pbconv.EventForGuest(e), pbconv.EmailsNone))
		}
		return guestEnc
	}
	rid := parseID(e.GetRoomId())
	involved := map[uuid.UUID]bool{parseID(e.GetOrganizerId()): true}
	for _, a := range e.GetAttendees() {
		if a.GetUserId() != "" {
			involved[parseID(a.GetUserId())] = true
		}
	}
	encs := map[pbconv.EmailView]*encEvent{}
	enc := func(v pbconv.EmailView) *encEvent {
		if encs[v] == nil {
			if v == pbconv.EmailsFull {
				encs[v] = newEnc(ev)
			} else {
				encs[v] = newEnc(wrap(pbconv.EventForViewer(e, v), v))
			}
		}
		return encs[v]
	}
	for _, s := range sessions {
		if st.role(s.user) == perm.RoleGuest {
			if roomOnly && rid != uuid.Nil && view(rid, s.user) {
				s.dispatchEnc(id, guest())
			}
			continue
		}
		inv := involved[s.user] && !s.bot
		sees := rid != uuid.Nil && view(rid, s.user)
		if !sees && (roomOnly || !inv) {
			continue
		}
		v := pbconv.EmailsMasked
		switch {
		case s.bot:
			v = pbconv.EmailsNone
		case inv:
			v = pbconv.EmailsFull
		case rid != uuid.Nil && st.bits(rid, s.user).Has(perm.ManageRoom):
			v = pbconv.EmailsFull
		case rid == uuid.Nil && st.members[s.user].Workspace().Has(perm.ManageWorkspace):
			v = pbconv.EmailsFull
		}
		s.dispatchEnc(id, enc(v))
	}
}
