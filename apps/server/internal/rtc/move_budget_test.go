package rtc

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/events"
)

// budgetProbe records, for each User() publish, whether the context still allowed any
// Redis time (events.Detached honours the request's post-commit budget).
type budgetProbe struct {
	events.Nop
	mu   sync.Mutex
	live []bool
}

func (p *budgetProbe) User(ctx context.Context, _ uuid.UUID, _ *v1.DispatchEvent) {
	dctx, done := events.Detached(ctx, time.Hour)
	defer done()
	p.mu.Lock()
	p.live = append(p.live, dctx.Err() == nil)
	p.mu.Unlock()
}

// VOICE_MOVED carries the join token of an app-level move: it must still be sent when the
// request's shared post-commit budget is already used up (by VOICE_STATE_UPDATE / stream
// events before it), otherwise the moved user sits in limbo until the 15 s rollback.
func TestVoiceMovedHasOwnBudget(t *testing.T) {
	probe := &budgetProbe{}
	s := &Service{events: probe}
	exhausted := events.WithBudget(context.Background(), 0)
	evs := []*v1.DispatchEvent{
		{Event: &v1.DispatchEvent_VoiceMoved{VoiceMoved: &v1.VoiceMoved{Token: "a"}}},
		{Event: &v1.DispatchEvent_VoiceMoved{VoiceMoved: &v1.VoiceMoved{Token: "b"}}},
	}
	s.publishMoved(exhausted, uuid.New(), evs)
	if len(probe.live) != len(evs) {
		t.Fatalf("published %d of %d VOICE_MOVED", len(probe.live), len(evs))
	}
	for i, ok := range probe.live {
		if !ok {
			t.Fatalf("VOICE_MOVED #%d published with an exhausted budget (would be dropped)", i)
		}
	}
}
