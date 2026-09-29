package calendar

import (
	"context"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// Room badge (ADR-0038 §6): ROOM_EVENT_ACTIVE from 15 minutes before an occurrence with a room
// until its end, ROOM_EVENT_ENDED after it; WorkspaceSnapshot.active_events after a reconnect.

// activeOcc returns b's occurrence with a room that is active at now.
func activeOcc(b *bundle, now time.Time) (Occurrence, bool) {
	if b == nil || b.ev.RoomID == nil || b.ev.CancelledAt != nil {
		return Occurrence{}, false
	}
	for _, o := range b.series.Between(now, now.Add(ActiveBefore+time.Second)) {
		if o.Active(now) {
			return o, true
		}
	}
	return Occurrence{}, false
}

const (
	signalActive = "active"
	signalEnded  = "ended"
)

func (s *Service) publishActive(ctx context.Context, b *bundle, o Occurrence) {
	s.ev.Workspace(ctx, b.ev.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomEventActive{RoomEventActive: &v1.RoomEventActive{
		WorkspaceId: b.ev.WorkspaceID.String(), RoomId: b.ev.RoomID.String(), Event: b.proto(&o, nil),
	}}})
}

func (s *Service) publishEnded(ctx context.Context, wsID, roomID, eventID uuid.UUID, occ time.Time) {
	s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomEventEnded{RoomEventEnded: &v1.RoomEventEnded{
		WorkspaceId: wsID.String(), RoomId: roomID.String(), EventId: eventID.String(), OccurrenceAt: timestamppb.New(occ),
	}}})
}

// roomSignals announces the room badge after a change of an event (before / after: nil when
// the event did not exist / is cancelled): the old active occurrence ends when it moved away,
// the new one (re)starts with the new details.
func (s *Service) roomSignals(ctx context.Context, before, after *bundle) {
	now := s.Now()
	ob, wasActive := activeOcc(before, now)
	oa, isActive := activeOcc(after, now)
	if wasActive && (!isActive || !ob.Start.Equal(oa.Start) || *before.ev.RoomID != *after.ev.RoomID) {
		s.publishEnded(ctx, before.ev.WorkspaceID, *before.ev.RoomID, before.ev.ID, ob.Start)
	}
	if isActive {
		_, err := s.db.Q.ClaimEventRoomSignal(ctx, sqlc.ClaimEventRoomSignalParams{EventID: after.ev.ID, OccurrenceAt: oa.Start, Kind: signalActive})
		logErr(ctx, "claim room signal", err)
		s.publishActive(ctx, after, oa)
	}
}

// FillActive sets WorkspaceSnapshot.active_events of the user's snapshots: the meetings active
// at now in the rooms each snapshot shows (its permissions map). One query for all of them;
// guests' snapshots stay empty.
func FillActive(ctx context.Context, q *sqlc.Queries, user uuid.UUID, bot bool, snaps []*v1.WorkspaceSnapshot, now time.Time) error {
	ids := make([]uuid.UUID, 0, len(snaps))
	bySnap := make(map[uuid.UUID]*v1.WorkspaceSnapshot, len(snaps))
	for _, s := range snaps {
		if s.GetRole() == v1.WorkspaceRole_WORKSPACE_ROLE_GUEST {
			continue
		}
		id, err := uuid.Parse(s.GetWorkspace().GetId())
		if err != nil {
			continue
		}
		ids = append(ids, id)
		bySnap[id] = s
	}
	if len(ids) == 0 {
		return nil
	}
	evs, err := q.ListRoomEventsNear(ctx, sqlc.ListRoomEventsNearParams{WorkspaceIds: ids, From: &now, To: now.Add(ActiveBefore + time.Second)})
	if err != nil || len(evs) == 0 {
		return err
	}
	kept := evs[:0]
	for _, e := range evs {
		if perm.Bits(bySnap[e.WorkspaceID].GetPermissions()[e.RoomID.String()]).Has(perm.ViewRoom) {
			kept = append(kept, e)
		}
	}
	bs, err := load(ctx, q, kept)
	if err != nil {
		return err
	}
	for _, b := range bs {
		o, ok := activeOcc(b, now)
		if !ok {
			continue
		}
		s := bySnap[b.ev.WorkspaceID]
		rooms := map[uuid.UUID]perm.Bits{*b.ev.RoomID: perm.Bits(s.GetPermissions()[b.ev.RoomID.String()])}
		v := &viewer{user: user, bot: bot, rooms: rooms}
		s.ActiveEvents = append(s.ActiveEvents, b.proto(&o, v))
	}
	return nil
}

// RecordingStarted links a recording to the meeting occurrence of its room (ADR-0038 §6): the
// starter must be the organizer, the start inside [start − 15 min, end). The occurrence's card
// gets it (ROOM_EVENT_ACTIVE again, lists: recording_id).
func (s *Service) RecordingStarted(ctx context.Context, rec sqlc.RoomRecording) {
	if rec.StartedBy == nil {
		return
	}
	at := rec.StartedAt
	evs, err := s.db.Q.ListEventsForRecording(ctx, sqlc.ListEventsForRecordingParams{
		RoomID: &rec.RoomID, OrganizerID: *rec.StartedBy, From: &at, To: at.Add(ActiveBefore + time.Second),
	})
	if err != nil {
		logErr(ctx, "recording: events", err)
		return
	}
	bs, err := load(ctx, s.db.Q, evs)
	if err != nil {
		logErr(ctx, "recording: load", err)
		return
	}
	for _, b := range bs {
		o, ok := activeOcc(b, at)
		if !ok {
			continue
		}
		n, err := s.db.Q.InsertEventRecording(ctx, sqlc.InsertEventRecordingParams{EventID: b.ev.ID, OccurrenceAt: o.Start, RecordingID: rec.ID})
		if err != nil || n == 0 {
			logErr(ctx, "recording: link", err)
			continue
		}
		if b.recs == nil {
			b.recs = map[int64]uuid.UUID{}
		}
		b.recs[o.Start.Unix()] = rec.ID
		if o.Active(s.Now()) {
			s.publishActive(ctx, b, o)
		}
		return // one meeting per recording
	}
}
