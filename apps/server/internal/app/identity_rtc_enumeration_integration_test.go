//go:build integration

package app_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/voice"
	"github.com/google/uuid"
)

// The three real rooms are discovered while five of the eight enumeration workers
// are blocked on unrelated SFU rooms. The remaining slow rooms exceed a sweep budget.
type identityEnumerationSFU struct {
	*identitySFU
	rooms             []rtc.Room
	healthy           map[string]bool
	blocked           chan struct{}
	evicted           chan struct{}
	started, finished atomic.Int32
	revokedRoom       string
}

func (s *identityEnumerationSFU) ListRooms(context.Context) ([]rtc.Room, error) { return s.rooms, nil }
func (s *identityEnumerationSFU) ListParticipants(ctx context.Context, room string) ([]rtc.Participant, error) {
	if s.healthy[room] {
		select {
		case <-s.blocked:
			return s.identitySFU.ListParticipants(ctx, room)
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if s.started.Add(1) == 5 {
		close(s.blocked)
	}
	<-ctx.Done()
	s.finished.Add(1)
	return nil, ctx.Err()
}
func (s *identityEnumerationSFU) RemoveParticipant(ctx context.Context, room, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.identitySFU.RemoveParticipant(ctx, room, id); err != nil {
		return err
	}
	if room == s.revokedRoom {
		close(s.evicted)
	}
	return nil
}

func TestIdentityRTCEnumerationLostRedisEvictsBeforeBarrierPreservesBAndDM(t *testing.T) {
	f := identitySetup(t, "enforced")
	ra, rb := identityVoiceRooms(t, f)
	uid := uuid.MustParse(f.local.id)
	roomA := voice.RoomName(uuid.MustParse(f.a.Id), uuid.MustParse(ra))
	roomB := voice.RoomName(uuid.MustParse(f.b.Id), uuid.MustParse(rb))
	var created v1.CreateDmResponse
	f.local.must(201, "POST", "/api/dms", &v1.CreateDmRequest{UserId: owner(t).id}, &created)
	dm := uuid.MustParse(created.Dm.GetRoom().GetId())
	roomDM := voice.RoomName(dm, dm)
	scopedID := voice.Identity(uid, f.scopedSession.ID)
	localID := voice.Identity(uid, uuid.MustParse(f.local.session))
	base := &identitySFU{LiveKit: lkRec, people: map[string]map[string]rtc.Participant{}}
	base.put(roomA, scopedID)
	base.put(roomB, localID)
	base.put(roomDM, localID)
	r, err := redisx.Connect(context.Background(), testRedisURL)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	a := app.New(app.Deps{Config: testCfg, DB: testDB, Redis: r, LiveKit: base, Events: events.Nop{}, Blob: testStore, Mail: testMail})
	if err := a.RTC.IdentityAccess(context.Background(), dm, dm, uid, f.scopedSession.ID); err == nil {
		t.Fatal("workspace_sso principal admitted to an ordinary DM")
	}
	outsider := register(t, invite(t, owner(t), f.b.Id))
	if err := a.RTC.IdentityAccess(context.Background(), dm, dm, uuid.MustParse(outsider.id), uuid.MustParse(outsider.session)); err == nil {
		t.Fatal("valid local principal admitted to someone else's DM")
	}
	if err := a.RTC.IdentityAccess(context.Background(), uuid.MustParse(f.b.Id), dm, uid, uuid.MustParse(f.local.session)); err == nil {
		t.Fatal("DM admitted under a workspace voice scope")
	}
	shelf := createShelf(t, f.local, "No media", "", 201)
	notesID := uuid.MustParse(shelf.GetRoom().GetId())
	if err := a.RTC.IdentityAccess(context.Background(), notesID, notesID, uid, uuid.MustParse(f.local.session)); err == nil {
		t.Fatal("notes shelf acquired DM media access")
	}
	if err := a.RTC.EnforceIdentity(context.Background()); err != nil {
		t.Fatal(err)
	}
	if base.wasRemoved(roomA, scopedID) || base.wasRemoved(roomB, localID) || base.wasRemoved(roomDM, localID) {
		t.Fatal("valid A/B/DM principal evicted")
	}
	if _, err := testDB.Q.RevokeWorkspaceAssurances(context.Background(), sqlc.RevokeWorkspaceAssurancesParams{WorkspaceID: uuid.MustParse(f.a.Id), SessionID: &f.scopedSession.ID}); err != nil {
		t.Fatal(err)
	}
	r.Close() // Lost invalidation and voice bookkeeping; DB/SFU remain authoritative.
	sfu := &identityEnumerationSFU{identitySFU: base, healthy: map[string]bool{roomA: true, roomB: true, roomDM: true},
		rooms: []rtc.Room{{Name: roomA}, {Name: roomB}, {Name: roomDM}}, blocked: make(chan struct{}), evicted: make(chan struct{}), revokedRoom: roomA}
	for range 168 {
		// Sort after the real UUIDv7 workspaces, independent of SFU response order.
		sfu.rooms = append(sfu.rooms, rtc.Room{Name: voice.RoomName(uuid.MustParse("ffffffff-ffff-ffff-ffff-ffffffffffff"), uuid.New())})
	}
	// Wire a fresh RTC instance to the same real DB gate, without starting app workers.
	svc := rtc.NewService(rtc.Config{}, testDB, r, sfu, events.Nop{})
	var checked atomic.Int32
	allChecked := make(chan struct{})
	svc.IdentityAccess = func(ctx context.Context, ws, room, user, session uuid.UUID) error {
		err := a.RTC.IdentityAccess(ctx, ws, room, user, session)
		if checked.Add(1) == 3 {
			close(allChecked)
		}
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	started := time.Now()
	done := make(chan error, 1)
	go func() { done <- svc.EnforceIdentity(ctx) }()
	for _, signal := range []<-chan struct{}{sfu.evicted, allChecked} {
		select {
		case <-signal:
		case err := <-done:
			t.Fatalf("sweep ended before real DB enforcement: %v", err)
		}
	}
	if sfu.finished.Load() != 0 {
		t.Errorf("DB/SFU enforcement waited for %d unrelated room enumerations", sfu.finished.Load())
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation hidden: %v", err)
	}
	if !base.wasRemoved(roomA, scopedID) || base.wasRemoved(roomB, localID) || base.wasRemoved(roomDM, localID) {
		t.Fatal("revoked A or independent B/DM eviction was incorrect")
	}
	if elapsed := time.Since(started); elapsed > 30*time.Second {
		t.Fatalf("revocation lease exceeded: %v", elapsed)
	}
	t.Logf("real DB revoked A removed with lost Redis before enumeration barrier; allowed B/DM checked; elapsed=%v", time.Since(started))
}
