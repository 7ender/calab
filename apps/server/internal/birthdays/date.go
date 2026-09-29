// Package birthdays handles users' birthdays (docs/09 #76, as in Telegram): validation of the date,
// "is it today" in the celebrant's time zone (else the workspace owner's), the hourly worker that posts a card into every
// shared workspace, and GET /api/workspaces/{id}/birthdays (upcoming birthdays).
package birthdays

import (
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
)

// MinYear is the earliest birth year accepted.
const MinYear = 1900

// Validate checks a birthday of PATCH /api/me: a real day of the month (29 February always:
// without a year it may be a leap year), the year, if given, between MinYear and now's year
// and making a date not in the future.
func Validate(b *v1.Birthday, now time.Time) error {
	d, m := int(b.GetDay()), int(b.GetMonth())
	if m < 1 || m > 12 {
		return httpx.Validation("birthday.month", "month must be 1..12")
	}
	year := 2000 // a leap year: 29 February is a valid birthday without a year
	if b.Year != nil {
		year = int(b.GetYear())
		if year < MinYear || year > now.Year() {
			return httpx.Validation("birthday.year", "year must be between 1900 and the current year")
		}
	}
	if d < 1 || d > daysIn(year, time.Month(m)) {
		return httpx.Validation("birthday.day", "no such day in that month")
	}
	if b.Year != nil && time.Date(year, time.Month(m), d, 0, 0, 0, 0, time.UTC).After(now) {
		return httpx.Validation("birthday", "birthday is in the future")
	}
	return nil
}

// Columns turns a birthday of a request into the users.birthday_* values: nil, nil, nil for
// no birthday or day = 0 and month = 0 without a year (clear it), else the validated date (see
// Validate).
func Columns(b *v1.Birthday, now time.Time) (day, month, year *int16, err error) {
	if b == nil || (b.GetDay() == 0 && b.GetMonth() == 0 && b.Year == nil) {
		return nil, nil, nil, nil
	}
	if err := Validate(b, now); err != nil {
		return nil, nil, nil, err
	}
	d, m := int16(b.GetDay()), int16(b.GetMonth()) //nolint:gosec // validated
	if b.Year != nil {
		y := int16(b.GetYear()) //nolint:gosec // validated
		year = &y
	}
	return &d, &m, year, nil
}

func daysIn(year int, m time.Month) int {
	return time.Date(year, m+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func leap(year int) bool { return daysIn(year, time.February) == 29 }

// celebrated returns the (month, day) a birthday is celebrated on in year: 29 February moves
// to 28 February outside leap years.
func celebrated(day, month, year int) (int, int) {
	if month == 2 && day == 29 && !leap(year) {
		return 2, 28
	}
	return month, day
}

// IsToday reports whether the birthday falls on local's calendar date (local is a time in the
// owner's zone).
func IsToday(day, month int, local time.Time) bool {
	m, d := celebrated(day, month, local.Year())
	return int(local.Month()) == m && local.Day() == d
}

// DaysUntil is how many days from today (a date in the viewer's zone) until the birthday is
// next celebrated: 0 = today.
func DaysUntil(day, month int, today time.Time) int {
	t := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC)
	for y := t.Year(); ; y++ {
		m, d := celebrated(day, month, y)
		next := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC)
		if !next.Before(t) {
			return int(next.Sub(t).Hours() / 24)
		}
	}
}

// Zone is the user's time zone: the IANA name, else UTC (unset or unknown).
func Zone(tz *string) *time.Location {
	if loc, ok := loadZone(tz); ok {
		return loc
	}
	return time.UTC
}

// GreetZone is the zone whose GreetAt o'clock the birthday card waits for: the celebrant's,
// else the workspace owner's (a team in one city gets it at 09:00 of its city, not of UTC),
// else UTC. An unknown name counts as unset. The client repeats it for the «card at 09:00» hint
// (lib/birthday.ts greetZone).
func GreetZone(user, owner *string) *time.Location {
	if loc, ok := loadZone(user); ok {
		return loc
	}
	return Zone(owner)
}

// loadZone loads an IANA zone name; false when unset or unknown.
func loadZone(tz *string) (*time.Location, bool) {
	if tz == nil || *tz == "" {
		return nil, false
	}
	loc, err := time.LoadLocation(*tz)
	if err != nil {
		return nil, false
	}
	return loc, true
}

// candidateKeys are the month*100+day keys of the dates that are "today" somewhere on Earth
// at now (UTC-12 … UTC+14: yesterday, today and tomorrow in UTC), with 29 February added to a
// 28 February of a common year.
func candidateKeys(now time.Time) []int32 {
	var keys []int32
	u := now.UTC()
	for _, off := range []int{-1, 0, 1} {
		t := u.AddDate(0, 0, off)
		keys = append(keys, int32(int(t.Month())*100+t.Day())) //nolint:gosec // ≤ 1231
		if t.Month() == time.February && t.Day() == 28 && !leap(t.Year()) {
			keys = append(keys, 229)
		}
	}
	return keys
}
