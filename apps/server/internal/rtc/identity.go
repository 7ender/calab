package rtc

import (
	"context"
	"errors"
	"log/slog"
	"sort"
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

const (
	identityRoomWorkers        = 8
	identityParticipantWorkers = 64
)

// A context-aware semaphore serializes sweeps without holding a mutex over I/O.
// Its owner also owns the cursor, including when a sweep exhausts its budget.
type identitySweepState struct {
	once     sync.Once
	token    chan struct{}
	lastRoom string
}

// EnforceIdentity enumerates the SFU independently of Redis. Lost pubsub, a lost webhook
// and an unavailable voice-state store cannot keep a denied participant connected.
// Errors from the gate deny; SFU removal failures remain visible and are retried.
func (s *Service) EnforceIdentity(ctx context.Context) error {
	state := &s.identitySweep
	state.once.Do(func() { state.token = make(chan struct{}, 1) })
	select {
	case state.token <- struct{}{}:
		defer func() { <-state.token }()
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	rooms, err := s.lk.ListRooms(ctx)
	if err != nil {
		return err
	}
	// SFU ordering is not stable. Keep only a name cursor between sweeps and resume
	// after the last scheduled room, rather than retrying a slow prefix forever.
	names := make([]string, 0, len(rooms))
	for _, room := range rooms {
		if _, _, ok := voice.ParseRoomName(room.Name); ok {
			names = append(names, room.Name)
		}
	}
	sort.Strings(names)
	start := sort.Search(len(names), func(i int) bool { return names[i] > state.lastRoom })
	if start == len(names) {
		start = 0
	}
	type roomParticipants struct {
		room    string
		ws, rid uuid.UUID
		people  []Participant
	}
	type participantJob struct {
		room    string
		ws, rid uuid.UUID
		person  Participant
	}
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
	roomJobs := make(chan string)
	results := make(chan roomParticipants)
	var enumeration sync.WaitGroup
	for range identityRoomWorkers {
		enumeration.Add(1)
		go func() {
			defer enumeration.Done()
			for room := range roomJobs {
				if ctx.Err() != nil {
					return
				}
				ws, rid, _ := voice.ParseRoomName(room)
				request, cancel := context.WithTimeout(ctx, time.Second)
				people, err := s.lk.ListParticipants(request, room)
				cancel()
				record(err)
				if err != nil {
					people = nil
				}
				select {
				case results <- roomParticipants{room, ws, rid, people}:
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	jobs := make(chan participantJob)
	var enforcement sync.WaitGroup
	for range identityParticipantWorkers {
		enforcement.Add(1)
		go func() {
			defer enforcement.Done()
			for job := range jobs {
				if ctx.Err() != nil {
					return
				}
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
				if ctx.Err() != nil {
					return
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
	// Stream discovered rooms immediately into enforcement, round-robin over at most
	// eight room responses. Backpressure bounds retained responses to this queue plus
	// one per enumerator, instead of accumulating every room's participants.
	groups := make([]roomParticipants, 0, identityRoomWorkers)
	scheduled, pending := 0, 0
	for scheduled < len(names) || pending > 0 || len(groups) > 0 {
		if ctx.Err() != nil {
			break
		}
		var sendRoom chan string
		var nextRoom string
		if scheduled < len(names) {
			sendRoom = roomJobs
			nextRoom = names[(start+scheduled)%len(names)]
		}
		var receiveRoom chan roomParticipants
		if len(groups) < identityRoomWorkers {
			receiveRoom = results
		}
		var sendPerson chan participantJob
		var nextPerson participantJob
		if len(groups) > 0 {
			group := groups[0]
			sendPerson = jobs
			nextPerson = participantJob{group.room, group.ws, group.rid, group.people[0]}
		}
		select {
		case sendRoom <- nextRoom:
			state.lastRoom = nextRoom
			scheduled++
			pending++
		case group := <-receiveRoom:
			pending--
			if len(group.people) > 0 {
				groups = append(groups, group)
			}
		case sendPerson <- nextPerson:
			group := groups[0]
			group.people = group.people[1:]
			copy(groups, groups[1:])
			groups[len(groups)-1] = roomParticipants{}
			groups = groups[:len(groups)-1]
			if len(group.people) > 0 {
				groups = append(groups, group)
			}
		case <-ctx.Done():
		}
	}
	close(roomJobs)
	enumeration.Wait()
	close(jobs)
	enforcement.Wait()
	record(ctx.Err())
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
