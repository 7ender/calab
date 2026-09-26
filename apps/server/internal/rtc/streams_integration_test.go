//go:build integration

package rtc

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/voice"
)

// listHookLK runs afterList once, right after the first ListParticipants: it simulates a
// webhook handled between the LiveKit listing and Reconcile's read of voice.Streams.
type listHookLK struct {
	*fakeLK
	once      sync.Once
	afterList func()
}

func (f *listHookLK) ListParticipants(ctx context.Context, room string) ([]Participant, error) {
	ps, err := f.fakeLK.ListParticipants(ctx, room)
	f.once.Do(f.afterList)
	return ps, err
}

// stopRec records VOICE_STREAM_STOP track sids.
type stopRec struct {
	events.Nop
	mu    sync.Mutex
	stops []string
}

func (r *stopRec) Workspace(_ context.Context, _ uuid.UUID, ev *v1.DispatchEvent) {
	if st := ev.GetVoiceStreamStop(); st != nil {
		r.mu.Lock()
		r.stops = append(r.stops, st.GetTrackSid())
		r.mu.Unlock()
	}
}

func (r *stopRec) stopped(track string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.stops {
		if s == track {
			return true
		}
	}
	return false
}

// A stream recorded by a track_published handled after Reconcile listed the participants
// is not in that listing; Reconcile must not drop it (VOICE_STREAM_STOP ENDED followed by a
// re-add on the next tick = flicker). Streams older than joinGrace, and legacy records
// without a start time, whose tracks are gone are still dropped.
func TestReconcileKeepsStreamPublishedAfterListing(t *testing.T) {
	wid, rid, uid, sid := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	identity := voice.Identity(uid, sid)
	lk := &listHookLK{fakeLK: &fakeLK{rooms: map[string][]Participant{
		voice.RoomName(wid, rid): {{Identity: identity}}, // no screen share track in the listing
	}}}
	s, _ := testService(t, lk)
	rec := &stopRec{}
	s.events = rec
	ctx := context.Background()
	setState(t, s, wid, uid, sid, rid, time.Now().Add(-2*joinGrace).UnixMilli())

	add := func(track string, started int64) {
		t.Helper()
		if ok, err := s.voice.AddStream(ctx, rid, track, voice.Stream{Identity: identity, UserID: uid, Started: started}, -1); err != nil || !ok {
			t.Fatalf("add stream %s: ok=%v err=%v", track, ok, err)
		}
	}
	add("TR_old", time.Now().Add(-2*joinGrace).UnixMilli())
	add("TR_legacy", 0)
	lk.afterList = func() { add("TR_new", time.Now().UnixMilli()) } // webhook after the listing

	if err := s.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	streams, err := s.voice.Streams(ctx, rid)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := streams["TR_new"]; !ok || rec.stopped("TR_new") {
		t.Fatalf("stream published after the listing was dropped (stops %v)", rec.stops)
	}
	for _, tr := range []string{"TR_old", "TR_legacy"} {
		if _, ok := streams[tr]; ok || !rec.stopped(tr) {
			t.Fatalf("control: stale stream %s with no track not dropped (stops %v)", tr, rec.stops)
		}
	}
}
