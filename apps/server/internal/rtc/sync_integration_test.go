//go:build integration

package rtc

import (
	"context"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/events"
)

// recPub records what SyncPublisher hands to the real publisher.
type recPub struct {
	events.Nop
	mu  sync.Mutex
	got [][]*v1.DispatchEvent
}

func (r *recPub) WorkspaceEvents(_ context.Context, _ uuid.UUID, evs []*v1.DispatchEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.got = append(r.got, evs)
}

func roomEv(id uuid.UUID, typ v1.RoomType) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomUpdate{RoomUpdate: &v1.RoomUpdate{
		Room: &v1.Room{Id: id.String(), Type: typ},
	}}}
}

// countingClient counts Redis round trips (Do + DoMulti calls) made through it.
type countingClient struct {
	rueidis.Client
	mu    sync.Mutex
	calls int
}

func (c *countingClient) Do(ctx context.Context, cmd rueidis.Completed) rueidis.RedisResult {
	c.mu.Lock()
	c.calls++
	c.mu.Unlock()
	return c.Client.Do(ctx, cmd)
}

func (c *countingClient) DoMulti(ctx context.Context, multi ...rueidis.Completed) []rueidis.RedisResult {
	c.mu.Lock()
	c.calls++
	c.mu.Unlock()
	return c.Client.DoMulti(ctx, multi...)
}

// A batch of ROOM_UPDATEs (reorder) reads the call starts of all its voice rooms in ONE
// round trip, fills them per room, keeps order and non-voice events untouched, and does
// not modify the caller's events. Per-room reads used to eat the request's publish budget
// before the first PUBLISH on a slow Redis.
func TestWorkspaceEventsCallStartsBatched(t *testing.T) {
	s, rc := testService(t, &fakeLK{})
	counter := &countingClient{Client: rc}
	s.voice.C = counter

	busy, idle, text := uuid.New(), uuid.New(), uuid.New()
	start := time.Now().Add(-7 * time.Minute).Truncate(time.Millisecond)
	if err := rc.Do(context.Background(), rc.B().Set().Key("voice:started:"+busy.String()).
		Value(strconv.FormatInt(start.UnixMilli(), 10)).Build()).Error(); err != nil {
		t.Fatal(err)
	}

	rec := &recPub{}
	p := SyncPublisher{Publisher: rec, S: s}
	in := []*v1.DispatchEvent{
		roomEv(idle, v1.RoomType_ROOM_TYPE_VOICE),
		roomEv(text, v1.RoomType_ROOM_TYPE_TEXT),
		roomEv(busy, v1.RoomType_ROOM_TYPE_VOICE),
	}
	p.WorkspaceEvents(events.WithBudget(context.Background(), time.Second), uuid.New(), in)

	if counter.calls != 1 {
		t.Fatalf("call starts read in %d Redis round trips, want 1", counter.calls)
	}
	if len(rec.got) != 1 || len(rec.got[0]) != 3 {
		t.Fatalf("published %v", rec.got)
	}
	out := rec.got[0]
	for i, id := range []uuid.UUID{idle, text, busy} {
		if out[i].GetRoomUpdate().GetRoom().GetId() != id.String() {
			t.Fatalf("order changed at %d", i)
		}
	}
	if got := out[2].GetRoomUpdate().GetRoom().GetVoiceStartedAt(); got == nil || !got.AsTime().Equal(start) {
		t.Fatalf("busy room: voice_started_at = %v, want %v", got, start)
	}
	if out[0].GetRoomUpdate().GetRoom().GetVoiceStartedAt() != nil {
		t.Fatal("idle room got a call start")
	}
	if out[1] != in[1] {
		t.Fatal("text room event was replaced")
	}
	if in[2].GetRoomUpdate().GetRoom().GetVoiceStartedAt() != nil {
		t.Fatal("caller's event was modified")
	}

	// Budget already used up: no wait, the events still go to the publisher (which then
	// fails fast and logs once) instead of being dropped here.
	exhausted := events.WithBudget(context.Background(), 0)
	began := time.Now()
	p.WorkspaceEvents(exhausted, uuid.New(), in)
	if time.Since(began) > 500*time.Millisecond {
		t.Fatal("exhausted budget still waited")
	}
	if len(rec.got) != 2 || len(rec.got[1]) != 3 {
		t.Fatalf("events not handed to the publisher with an exhausted budget: %v", rec.got)
	}
}
