package rtc

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/voice"
	"github.com/google/uuid"
)

type identitySFU struct {
	LiveKit
	rooms   []Room
	people  map[string][]Participant
	mu      sync.Mutex
	removed map[string]int
}

func (f *identitySFU) ListRooms(context.Context) ([]Room, error) { return f.rooms, nil }
func (f *identitySFU) ListParticipants(_ context.Context, room string) ([]Participant, error) {
	return f.people[room], nil
}
func (f *identitySFU) RemoveParticipant(ctx context.Context, room, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed[room+id]++
	return nil
}

func TestIdentitySweepSlowDependencyMultipleRooms(t *testing.T) {
	denied, allowed := uuid.New(), uuid.New()
	f := &identitySFU{people: map[string][]Participant{}, removed: map[string]int{}}
	for i := 0; i < 8; i++ {
		ws := denied
		if i == 7 {
			ws = allowed
		}
		room := voice.RoomName(ws, uuid.New())
		f.rooms = append(f.rooms, Room{Name: room})
		for j := 0; j < 20; j++ {
			f.people[room] = append(f.people[room], Participant{Identity: voice.Identity(uuid.New(), uuid.New())})
		}
	}
	var inFlight, maxInFlight atomic.Int32
	svc := &Service{lk: f, IdentityAccess: func(ctx context.Context, ws, _, _, _ uuid.UUID) error {
		if ws == allowed {
			return nil
		}
		n := inFlight.Add(1)
		defer inFlight.Add(-1)
		for old := maxInFlight.Load(); n > old; old = maxInFlight.Load() {
			if maxInFlight.CompareAndSwap(old, n) {
				break
			}
		}
		<-ctx.Done()
		return ctx.Err()
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	if err := svc.EnforceIdentity(ctx); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 4*time.Second {
		t.Fatal("slow dependency starved later rooms")
	}
	if maxInFlight.Load() > 64 {
		t.Fatalf("unbounded concurrency: %d", maxInFlight.Load())
	}
	for i, room := range f.rooms {
		for _, p := range f.people[room.Name] {
			want := 1
			if i == 7 {
				want = 0
			}
			if got := f.removed[room.Name+p.Identity]; got != want {
				t.Fatalf("room %d removal=%d want=%d", i, got, want)
			}
		}
	}
}

func TestIdentitySweepCancellationDoesNotDetachRemoval(t *testing.T) {
	f := &identitySFU{rooms: []Room{{Name: voice.RoomName(uuid.New(), uuid.New())}}, people: map[string][]Participant{}, removed: map[string]int{}}
	f.people[f.rooms[0].Name] = []Participant{{Identity: voice.Identity(uuid.New(), uuid.New())}}
	ctx, cancel := context.WithCancel(context.Background())
	svc := &Service{lk: f, IdentityAccess: func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error {
		cancel()
		return errors.New("denied")
	}}
	if err := svc.EnforceIdentity(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("want cancellation, got %v", err)
	}
	if len(f.removed) != 0 {
		t.Fatal("removal detached from canceled sweep")
	}
}
