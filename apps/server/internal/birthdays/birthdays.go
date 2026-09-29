package birthdays

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// GreetAt is the local hour from which the card of the day is posted.
const GreetAt = 9

// Service runs the birthday worker and serves the upcoming-birthdays endpoint.
type Service struct {
	db     *db.DB
	system *messages.System
}

// New creates the service.
func New(d *db.DB, ev events.Publisher) *Service {
	return &Service{db: d, system: messages.NewSystem(d, ev)}
}

// Routes registers the endpoint; wrap applies auth + the permission resolver.
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/workspaces/{id}/birthdays", wrap(httpx.HandlerFunc(s.upcoming)))
}

// Run checks every interval (and once at start) whose birthday it is. Several instances may
// run it: the greeting row claims each card.
func (s *Service) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if n, err := s.Greet(ctx, time.Now()); err != nil {
			slog.ErrorContext(ctx, "birthday greetings", "err", err)
		} else if n > 0 {
			slog.InfoContext(ctx, "birthday cards posted", "count", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Greet posts the birthday cards due at now that are not posted yet: on the birthday, from
// GreetAt o'clock of the zone GreetZone picks for that workspace (the celebrant's, else the
// workspace owner's, else UTC). It returns how many it posted.
func (s *Service) Greet(ctx context.Context, now time.Time) (int, error) {
	people, err := s.db.Q.ListBirthdayCandidates(ctx, candidateKeys(now))
	if err != nil {
		return 0, err
	}
	posted := 0
	var errs []error
	for _, p := range people {
		if p.BirthdayDay == nil || p.BirthdayMonth == nil {
			continue
		}
		day, month := int(*p.BirthdayDay), int(*p.BirthdayMonth)
		// With a zone of their own the answer is the same for every workspace: skip the rooms
		// query when it is not time yet.
		if loc, ok := loadZone(p.Timezone); ok && !due(day, month, now.In(loc)) {
			continue
		}
		rooms, err := s.db.Q.ListBirthdayRooms(ctx, p.ID)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		for _, r := range rooms {
			local := now.In(GreetZone(p.Timezone, r.OwnerTimezone))
			if !due(day, month, local) {
				continue
			}
			ok, err := s.greet(ctx, p.ID, r, local)
			if ok {
				posted++
			}
			if err != nil {
				errs = append(errs, err)
			}
		}
	}
	// The dedup needs only the last days (a zone is at most a day away from UTC).
	if _, err := s.db.Q.DeleteOldBirthdayGreetings(ctx, pgtype.Date{Time: now.UTC().AddDate(0, 0, -3), Valid: true}); err != nil {
		errs = append(errs, err)
	}
	return posted, errors.Join(errs...)
}

// due reports whether the card of the birthday is due at local: its day, from GreetAt o'clock.
func due(day, month int, local time.Time) bool {
	return local.Hour() >= GreetAt && IsToday(day, month, local)
}

// greet posts the card of userID's birthday (on local's date) into room r unless it is posted
// already; it reports whether it posted.
func (s *Service) greet(ctx context.Context, userID uuid.UUID, r sqlc.ListBirthdayRoomsRow, local time.Time) (bool, error) {
	day := pgtype.Date{Time: time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC), Valid: true}
	payload, err := protojson.Marshal(&v1.SystemMessage{Payload: &v1.SystemMessage_Birthday{Birthday: &v1.BirthdayCard{
		Day: uint32(local.Day()), Month: uint32(local.Month()), //nolint:gosec // calendar values
	}}})
	if err != nil {
		return false, err
	}
	var msg sqlc.Message
	claimed := false
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		n, err := q.ClaimBirthdayGreeting(ctx, sqlc.ClaimBirthdayGreetingParams{UserID: userID, WorkspaceID: r.WorkspaceID, Day: day})
		if err != nil || n == 0 {
			return err
		}
		if msg, err = q.InsertSystemMessage(ctx, sqlc.InsertSystemMessageParams{RoomID: r.RoomID, AuthorID: userID, Payload: payload}); err != nil {
			return err
		}
		claimed = true
		return q.SetBirthdayGreetingMessage(ctx, sqlc.SetBirthdayGreetingMessageParams{
			UserID: userID, WorkspaceID: r.WorkspaceID, Day: day, MessageID: &msg.ID,
		})
	})
	if err != nil || !claimed {
		return false, err
	}
	return true, s.system.Created(ctx, r.WorkspaceID, msg)
}

// upcoming: GET /api/workspaces/{id}/birthdays?days=7.
func (s *Service) upcoming(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	me := auth.MustFromContext(ctx).UserID
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	_, role, err := perm.FromContext(ctx).Workspace(ctx, wsID, me)
	if errors.Is(err, perm.ErrNotMember) {
		return httpx.NotFound("workspace")
	}
	if err != nil {
		return err
	}
	if role == perm.RoleGuest {
		return httpx.Forbidden("not available for guests")
	}
	days := 7
	if v := r.URL.Query().Get("days"); v != "" {
		if days, err = strconv.Atoi(v); err != nil || days < 1 || days > 31 {
			return httpx.Validation("days", "days must be 1..31")
		}
	}
	u, err := s.db.Q.GetUser(ctx, me)
	if err != nil {
		return err
	}
	today := time.Now().In(Zone(u.Timezone))
	rows, err := s.db.Q.ListWorkspaceBirthdays(ctx, wsID)
	if err != nil {
		return err
	}
	out := &v1.ListBirthdaysResponse{Birthdays: []*v1.UpcomingBirthday{}}
	for _, row := range rows {
		if row.BirthdayDay == nil || row.BirthdayMonth == nil {
			continue
		}
		in := DaysUntil(int(*row.BirthdayDay), int(*row.BirthdayMonth), today)
		if in >= days {
			continue
		}
		out.Birthdays = append(out.Birthdays, &v1.UpcomingBirthday{
			UserId: row.ID.String(), Birthday: pbconv.Birthday(row.BirthdayDay, row.BirthdayMonth, row.BirthdayYear), InDays: uint32(in), //nolint:gosec // < 31
		})
	}
	slices.SortStableFunc(out.Birthdays, func(a, b *v1.UpcomingBirthday) int { return int(a.InDays) - int(b.InDays) })
	httpx.Write(w, http.StatusOK, out)
	return nil
}
