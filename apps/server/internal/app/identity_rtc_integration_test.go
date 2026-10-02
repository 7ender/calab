//go:build integration

package app_test

import (
	"context"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/voice"
	"github.com/google/uuid"
)

type identitySFU struct {
	rtc.LiveKit
	mu          sync.Mutex
	people      map[string]map[string]rtc.Participant
	removed     []string
	afterCreate func()
}

func (s *identitySFU) CreateRoom(_ context.Context, name string, _, _ uint32) error {
	s.mu.Lock()
	if s.people[name] == nil {
		s.people[name] = map[string]rtc.Participant{}
	}
	hook := s.afterCreate
	s.afterCreate = nil
	s.mu.Unlock()
	if hook != nil {
		hook()
	}
	return nil
}
func (s *identitySFU) ListRooms(context.Context) ([]rtc.Room, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []rtc.Room{}
	for name := range s.people {
		out = append(out, rtc.Room{Name: name})
	}
	return out, nil
}
func (s *identitySFU) ListParticipants(_ context.Context, name string) ([]rtc.Participant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []rtc.Participant{}
	for _, p := range s.people[name] {
		out = append(out, p)
	}
	return out, nil
}
func (s *identitySFU) GetParticipant(_ context.Context, room, id string) (*rtc.Participant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.people[room][id]
	if !ok {
		return nil, &rtc.Error{Code: "not_found", Status: 404}
	}
	return &p, nil
}
func (s *identitySFU) RemoveParticipant(_ context.Context, room, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.people[room], id)
	s.removed = append(s.removed, room+":"+id)
	return nil
}
func (s *identitySFU) UpdatePermission(context.Context, string, string, rtc.Permission) error {
	return nil
}
func (s *identitySFU) MoveParticipant(_ context.Context, room, id, dst string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.people[room][id]
	delete(s.people[room], id)
	if s.people[dst] == nil {
		s.people[dst] = map[string]rtc.Participant{}
	}
	s.people[dst][id] = p
	return nil
}
func (s *identitySFU) put(room, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.people[room] == nil {
		s.people[room] = map[string]rtc.Participant{}
	}
	s.people[room][id] = rtc.Participant{Identity: id, Sid: uuid.NewString()}
}
func (s *identitySFU) wasRemoved(room, id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Contains(s.removed, room+":"+id)
}
func identityVoiceRooms(t *testing.T, f identityFixture) (string, string) {
	t.Helper()
	ownerID := uuid.MustParse(owner(t).id)
	ids := []string{}
	for _, ws := range []string{f.a.Id, f.b.Id} {
		room, err := testDB.Q.CreateRoom(context.Background(), sqlc.CreateRoomParams{WorkspaceID: uuid.MustParse(ws), Name: "Identity voice", Type: "voice", CreatedBy: &ownerID})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, room.ID.String())
	}
	return ids[0], ids[1]
}

func TestIdentityRTCReconcileWithLostRedisPreservesIndependentWorkspace(t *testing.T) {
	f := identitySetup(t, "enforced")
	ra, rb := identityVoiceRooms(t, f)
	uid := uuid.MustParse(f.local.id)
	wsA, wsB := uuid.MustParse(f.a.Id), uuid.MustParse(f.b.Id)
	identity := voice.Identity(uid, f.scopedSession.ID)
	localIdentity := voice.Identity(uid, uuid.MustParse(f.local.session))
	roomA, roomB := voice.RoomName(wsA, uuid.MustParse(ra)), voice.RoomName(wsB, uuid.MustParse(rb))
	sfu := &identitySFU{LiveKit: lkRec, people: map[string]map[string]rtc.Participant{}}
	sfu.put(roomA, identity)
	sfu.put(roomB, localIdentity)
	r, err := redisx.Connect(context.Background(), testRedisURL)
	if err != nil {
		t.Fatal(err)
	}
	a := app.New(app.Deps{Config: testCfg, DB: testDB, Redis: r, LiveKit: sfu, Events: events.Nop{}, Blob: testStore, Mail: testMail})
	if err := a.RTC.EnforceIdentity(context.Background()); err != nil {
		t.Fatal(err)
	}
	if sfu.wasRemoved(roomA, identity) || sfu.wasRemoved(roomB, localIdentity) {
		t.Fatal("positive corporate/independent sessions evicted")
	}
	if _, err = testDB.Q.RevokeWorkspaceAssurances(context.Background(), sqlc.RevokeWorkspaceAssurancesParams{WorkspaceID: wsA, SessionID: &f.scopedSession.ID}); err != nil {
		t.Fatal(err)
	}
	r.Close() // no invalidation pubsub and no voice bookkeeping is available
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	if err := a.RTC.EnforceIdentity(ctx); err != nil {
		t.Fatal(err)
	}
	if !sfu.wasRemoved(roomA, identity) || sfu.wasRemoved(roomB, localIdentity) {
		t.Fatal("DB policy eviction did not isolate A from independent B")
	}
}

func TestIdentityRTCJoinAndLiveReplayRecheckAfterRevocation(t *testing.T) {
	f := identitySetup(t, "enforced")
	ra, rb := identityVoiceRooms(t, f)
	uid := uuid.MustParse(f.local.id)
	ws := uuid.MustParse(f.a.Id)
	rid := uuid.MustParse(ra)
	sfu := &identitySFU{LiveKit: lkRec, people: map[string]map[string]rtc.Participant{}}
	a := app.New(app.Deps{Config: testCfg, DB: testDB, Redis: testRedis, LiveKit: sfu, Events: events.Nop{}, Blob: testStore, Mail: testMail})
	server := httptest.NewServer(a.Handler)
	defer server.Close()
	// Workspace B cannot be selected with a valid A device, including voice routes.
	status, _, _ := identityRequest(t, server.URL, "POST", "/api/rooms/"+rb+"/join", f.scoped.token, "https://app.example.com", nil, nil)
	if status != 403 {
		t.Fatalf("cross-workspace join=%d", status)
	}
	sfu.mu.Lock()
	sfu.afterCreate = func() {
		_, err := testDB.Q.RevokeWorkspaceAssurances(context.Background(), sqlc.RevokeWorkspaceAssurancesParams{WorkspaceID: ws, SessionID: &f.scopedSession.ID})
		if err != nil {
			t.Error(err)
		}
	}
	sfu.mu.Unlock()
	status, raw, _ := identityRequest(t, server.URL, "POST", "/api/rooms/"+ra+"/join", f.scoped.token, "https://app.example.com", nil, nil)
	if status != 403 {
		t.Fatalf("join granted after remote preparation/revocation=%d %s", status, raw)
	}
	name := voice.RoomName(ws, rid)
	identity := voice.Identity(uid, f.scopedSession.ID)
	for _, event := range []string{rtc.EventParticipantJoined, rtc.EventTrackPublished} {
		sfu.put(name, identity)
		if err := a.RTC.HandleEvent(context.Background(), &rtc.WebhookEvent{Event: event, Room: &rtc.Room{Name: name}, Participant: &rtc.Participant{Identity: identity, Sid: uuid.NewString()}, Track: &rtc.Track{Sid: "TR_replay", Source: rtc.SourceMicrophone}}); err != nil {
			t.Fatal(err)
		}
		if _, err := sfu.GetParticipant(context.Background(), name, identity); !rtc.IsNotFound(err) {
			t.Fatalf("stale/live replay %s remained connected", event)
		}
	}
	// Room/workspace mismatches and a session belonging to another user fail closed.
	if err := a.RTC.IdentityAccess(context.Background(), uuid.MustParse(f.b.Id), rid, uid, f.scopedSession.ID); err == nil {
		t.Fatal("SFU workspace mismatch admitted")
	}
	if err := a.RTC.IdentityAccess(context.Background(), ws, rid, uuid.MustParse(owner(t).id), f.scopedSession.ID); err == nil {
		t.Fatal("SFU device/user mismatch admitted")
	}
}
