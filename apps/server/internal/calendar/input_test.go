package calendar

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Limits (docs/20 C.18): 120 / 4000 characters, 100 attendees, 20 external addresses.
func TestInputLimits(t *testing.T) {
	start := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	ok := fields{title: "Планёрка", start: start, end: start.Add(time.Hour), tz: "Europe/Moscow"}
	for name, mod := range map[string]func(f *fields){
		"title 121":        func(f *fields) { f.title = strings.Repeat("я", 121) },
		"description 4001": func(f *fields) { f.desc = strings.Repeat("я", 4001) },
		"no tz":            func(f *fields) { f.tz = "" },
		"8 days":           func(f *fields) { f.end = f.start.Add(8 * 24 * time.Hour) },
	} {
		f := ok
		mod(&f)
		if err := f.normalize(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	f := ok
	f.title, f.desc = strings.Repeat("я", 120), strings.Repeat("я", 4000)
	if err := f.normalize(); err != nil {
		t.Errorf("at the limits: %v", err)
	}
	// All-day rounds to midnights of the zone.
	f = ok
	f.allDay = true
	if err := f.normalize(); err != nil || !f.start.Equal(time.Date(2026, 10, 4, 21, 0, 0, 0, time.UTC)) || f.end.Sub(f.start) != 24*time.Hour {
		t.Errorf("all-day: %v %v %v", f.start, f.end, err)
	}

	var many []*v1.CalendarEventAttendeeInput
	for range 101 {
		many = append(many, &v1.CalendarEventAttendeeInput{UserId: uuid.NewString()})
	}
	if _, err := parseAttendees(many); err == nil {
		t.Error("101 attendees accepted")
	}
	var ext []*v1.CalendarEventAttendeeInput
	for i := range 21 {
		ext = append(ext, &v1.CalendarEventAttendeeInput{Email: fmt.Sprintf("x%d@outside.org", i)})
	}
	if _, err := parseAttendees(ext); err == nil {
		t.Error("21 externals accepted")
	}
	got, err := parseAttendees(append(ext[:20], &v1.CalendarEventAttendeeInput{Email: "X0@Outside.org", Required: true}))
	if err != nil || len(got) != 20 || !got[0].required || got[0].email != "x0@outside.org" {
		t.Errorf("duplicates merged: %v %v", got, err)
	}
	for _, bad := range []string{"no", "a@b", "a b@c.de", "<a@b.cd>", "Ann <a@b.cd>"} {
		if _, err := parseAttendees([]*v1.CalendarEventAttendeeInput{{Email: bad}}); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
