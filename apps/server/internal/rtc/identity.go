package rtc

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/calaba/calaba/server/internal/voice"
	"github.com/google/uuid"
)

// checkIdentity is session-specific and separate from member permission computation.
func (s *Service) checkIdentity(ctx context.Context, ws, room, user, session uuid.UUID) error {
	if s.IdentityAccess == nil {
		return errors.New("RTC identity gate unavailable")
	}
	return s.IdentityAccess(ctx, ws, room, user, session)
}

// EnforceIdentity enumerates the SFU independently of Redis. Lost pubsub, a lost webhook
// and an unavailable voice-state store cannot keep a denied participant connected.
// Errors from the gate deny; SFU removal failures remain visible and are retried.
func (s *Service) EnforceIdentity(ctx context.Context) error {
	rooms, err := s.lk.ListRooms(ctx)
	if err != nil {
		return err
	}
	// Enumeration and enforcement use bounded pools. A slow room or dependency cannot
	// hold up every other room, and cancellations stop both scheduling and removals.
	type roomParticipants struct {
		room    string
		ws, rid uuid.UUID
		people  []Participant
	}
	groups := make([]roomParticipants, len(rooms))
	var mu sync.Mutex
	var firstErr error
	record := func(err error) {
		if err != nil {
			mu.Lock()
			if firstErr == nil {
				firstErr = err
			}
			mu.Unlock()
		}
	}
	indices := make(chan int)
	var enumeration sync.WaitGroup
	for i := 0; i < 8; i++ {
		enumeration.Add(1)
		go func() {
			defer enumeration.Done()
			for index := range indices {
				room := rooms[index]
				ws, rid, ok := voice.ParseRoomName(room.Name)
				if !ok {
					continue
				}
				request, cancel := context.WithTimeout(ctx, time.Second)
				people, err := s.lk.ListParticipants(request, room.Name)
				cancel()
				if err != nil {
					record(err)
					continue
				}
				groups[index] = roomParticipants{room.Name, ws, rid, people}
			}
		}()
	}
	for index := range rooms {
		select {
		case indices <- index:
		case <-ctx.Done():
			record(ctx.Err())
		}
		if ctx.Err() != nil {
			break
		}
	}
	close(indices)
	enumeration.Wait()
	type participantJob struct {
		room    string
		ws, rid uuid.UUID
		person  Participant
	}
	jobs := make(chan participantJob)
	var enforcement sync.WaitGroup
	for i := 0; i < 64; i++ {
		enforcement.Add(1)
		go func() {
			defer enforcement.Done()
			for job := range jobs {
				uid, sid, ok := voice.ParseIdentity(job.person.Identity)
				if !ok {
					continue
				}
				gate, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
				err := s.checkIdentity(gate, job.ws, job.rid, uid, sid)
				cancel()
				if err == nil {
					continue
				}
				remove, done := context.WithTimeout(ctx, 2*time.Second)
				err = s.lk.RemoveParticipant(remove, job.room, job.person.Identity)
				done()
				if err != nil && !IsNotFound(err) {
					record(err)
					continue
				}
				// Redis is bookkeeping after authoritative SFU eviction, never its prerequisite.
				if s.voice.C != nil {
					clean, done := context.WithTimeout(ctx, 100*time.Millisecond)
					_ = s.update(clean, job.ws, uid, sid, func(cur *voice.SessionState) *voice.SessionState {
						if cur != nil && cur.RoomID == job.rid {
							return nil
						}
						return cur
					})
					done()
				}
			}
		}()
	}
	// Interleave participants from different rooms rather than starving the last room.
scheduling:
	for offset := 0; ; offset++ {
		remaining := false
		for _, group := range groups {
			if offset >= len(group.people) {
				continue
			}
			remaining = true
			select {
			case jobs <- participantJob{group.room, group.ws, group.rid, group.people[offset]}:
			case <-ctx.Done():
				record(ctx.Err())
				break scheduling
			}
		}
		if !remaining {
			break
		}
	}
	close(jobs)
	enforcement.Wait()
	return firstErr
}

// RunIdentityEnforcement supplements immediate mutation hooks with a short DB/SFU sweep.
func (s *Service) RunIdentityEnforcement(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-s.identityWake:
		}
		{
			work, cancel := context.WithTimeout(ctx, 20*time.Second)
			if err := s.EnforceIdentity(work); err != nil && ctx.Err() == nil {
				slog.WarnContext(ctx, "RTC identity sweep failed", "err", err)
			}
			cancel()
		}
	}
}

// IdentityChanged coalesces versioned revocations; the next sweep reads the DB source.
func (s *Service) IdentityChanged() {
	select {
	case s.identityWake <- struct{}{}:
	default:
	}
}
