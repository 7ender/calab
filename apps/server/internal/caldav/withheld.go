package caldav

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/calendar"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Withheld meetings (ADR-0054). A change the workspace identity policy keeps inside Calab for
// a user (no current SSO assurance in an enforced workspace, identity-suspended, …) is not
// pushed; the copy uploaded earlier would stay in the external calendar with stale content.
// Such a meeting is remembered here: the push worker deletes that copy (content-free) and
// checks again every withheldRecheck; once the policy lets the meeting out (or it is gone for
// the user) the regular push is queued again — the catch-up. Best effort: the record lives in
// Valkey; losing it only leaves the old copy / skips the catch-up until the next change.
const (
	withheldKey     = "caldav:withheld"      // ZSET "<user>:<event>" → next check (unix ms)
	withheldInfoKey = "caldav:withheld:info" // HASH "<user>:<event>" → "<since unix ms>:<copy deleted 0|1>"
	withheldRecheck = 10 * time.Minute
	withheldRetry   = time.Minute
	withheldMaxAge  = 30 * 24 * time.Hour
	withheldBatch   = 100
)

func withheldMember(user, event uuid.UUID) string { return user.String() + ":" + event.String() }

// withhold remembers that the meeting is held back from user; it is due at once (the copy is
// deleted on the next worker pass).
func (s *Service) withhold(ctx context.Context, user, event uuid.UUID) {
	m := withheldMember(user, event)
	now := s.Now().UnixMilli()
	for _, r := range s.redis.DoMulti(ctx,
		s.redis.B().Hsetnx().Key(redisx.Key(withheldInfoKey)).Field(m).Value(fmt.Sprintf("%d:0", now)).Build(),
		s.redis.B().Zadd().Key(redisx.Key(withheldKey)).ScoreMember().ScoreMember(float64(now), m).Build(),
	) {
		if err := r.Error(); err != nil {
			slog.WarnContext(ctx, "caldav: withhold", "user_id", user, "event_id", event, "err", err)
			return
		}
	}
	s.poke()
}

func (s *Service) forgetWithheld(ctx context.Context, m string) {
	for _, r := range s.redis.DoMulti(ctx,
		s.redis.B().Zrem().Key(redisx.Key(withheldKey)).Member(m).Build(),
		s.redis.B().Hdel().Key(redisx.Key(withheldInfoKey)).Field(m).Build(),
	) {
		if err := r.Error(); err != nil {
			slog.WarnContext(ctx, "caldav: forget withheld", "err", err)
		}
	}
}

func (s *Service) recheckWithheld(ctx context.Context, m string, at time.Time) {
	if err := s.redis.Do(ctx, s.redis.B().Zadd().Key(redisx.Key(withheldKey)).ScoreMember().ScoreMember(float64(at.UnixMilli()), m).Build()).Error(); err != nil {
		slog.WarnContext(ctx, "caldav: recheck withheld", "err", err)
	}
}

// ProcessWithheld handles the due withheld meetings: deletes the external copy once, queues
// the catch-up push when the policy lets the meeting out again. The caller holds the push
// lock (tests call it directly). It returns how many entries were handled.
func (s *Service) ProcessWithheld(ctx context.Context) (int, error) {
	now := s.Now()
	members, err := s.redis.Do(ctx, s.redis.B().Zrangebyscore().Key(redisx.Key(withheldKey)).Min("-inf").
		Max(strconv.FormatInt(now.UnixMilli(), 10)).Limit(0, withheldBatch).Build()).AsStrSlice()
	if err != nil {
		return 0, err
	}
	for _, m := range members {
		s.withheldStep(ctx, m, now)
	}
	return len(members), nil
}

func (s *Service) withheldStep(ctx context.Context, m string, now time.Time) {
	rawUser, rawEvent, _ := strings.Cut(m, ":")
	user, e1 := uuid.Parse(rawUser)
	event, e2 := uuid.Parse(rawEvent)
	if e1 != nil || e2 != nil {
		s.forgetWithheld(ctx, m)
		return
	}
	since, deleted := now, false
	if info, err := s.redis.Do(ctx, s.redis.B().Hget().Key(redisx.Key(withheldInfoKey)).Field(m).Build()).ToString(); err == nil {
		ms, flag, _ := strings.Cut(info, ":")
		if v, err := strconv.ParseInt(ms, 10, 64); err == nil {
			since = time.UnixMilli(v)
		}
		deleted = flag == "1"
	} else if !rueidis.IsRedisNil(err) {
		s.recheckWithheld(ctx, m, now.Add(withheldRetry))
		return
	}
	acc, err := s.db.Q.GetCalDavAccount(ctx, user)
	if db.IsNotFound(err) || err == nil && (!acc.Push || acc.CalendarHref == nil) {
		s.forgetWithheld(ctx, m) // disconnected or the push turned off: nothing of ours to manage
		return
	}
	if err != nil {
		s.recheckWithheld(ctx, m, now.Add(withheldRetry))
		return
	}
	if ok, err := s.allowed(ctx, user); err == nil && !ok {
		s.forgetWithheld(ctx, m)
		return
	}
	_, _, err = s.cal.EventForCalDAV(ctx, event, user)
	switch {
	case errors.Is(err, calendar.ErrWithheld):
		if now.Sub(since) > withheldMaxAge {
			s.forgetWithheld(ctx, m)
			return
		}
		if !deleted {
			if err := s.withdraw(ctx, acc, event); err != nil {
				slog.InfoContext(ctx, "caldav: withdraw withheld copy", "user_id", user, "event_id", event, "err", err)
				s.recheckWithheld(ctx, m, now.Add(withheldRetry))
				return
			}
			if err := s.redis.Do(ctx, s.redis.B().Hset().Key(redisx.Key(withheldInfoKey)).FieldValue().
				FieldValue(m, fmt.Sprintf("%d:1", since.UnixMilli())).Build()).Error(); err != nil {
				slog.WarnContext(ctx, "caldav: withheld state", "err", err)
			}
		}
		s.recheckWithheld(ctx, m, now.Add(withheldRecheck))
	case err != nil:
		s.recheckWithheld(ctx, m, now.Add(withheldRetry))
	default:
		// The policy lets the meeting out again, or it is gone for the user: the regular push
		// puts the current version (or deletes the copy).
		if _, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (int64, error) {
			return guarded.EnqueueCalDavPushes(ctx, sqlc.EnqueueCalDavPushesParams{EventID: event, Ids: []uuid.UUID{user}})
		}); err != nil {
			slog.WarnContext(ctx, "caldav: catch-up push", "err", err)
			s.recheckWithheld(ctx, m, now.Add(withheldRetry))
			return
		}
		s.forgetWithheld(ctx, m)
		s.poke()
	}
}

// withdraw deletes the meeting's object from the user's calendar (no content is sent).
func (s *Service) withdraw(ctx context.Context, acc sqlc.CaldavAccount, eventID uuid.UUID) error {
	cr, err := s.open(acc)
	if err != nil {
		return err
	}
	return s.dav.Delete(ctx, strings.TrimRight(*acc.CalendarHref, "/")+"/"+eventID.String()+".ics", cr)
}
