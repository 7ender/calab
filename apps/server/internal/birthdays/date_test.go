package birthdays

import (
	"slices"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func yr(y uint32) *uint32 { return &y }

func TestValidate(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	ok := []*v1.Birthday{
		{Day: 15, Month: 3},
		{Day: 29, Month: 2},                 // no year: may be a leap year
		{Day: 29, Month: 2, Year: yr(2000)}, // leap
		{Day: 31, Month: 12, Year: yr(1990)},
		{Day: 28, Month: 9, Year: yr(2026)}, // today
		{Day: 1, Month: 1, Year: yr(1900)},
	}
	for _, b := range ok {
		if err := Validate(b, now); err != nil {
			t.Errorf("%v: %v", b, err)
		}
	}
	bad := []*v1.Birthday{
		{Day: 0, Month: 3},
		{Day: 32, Month: 1},
		{Day: 31, Month: 4},
		{Day: 30, Month: 2},
		{Day: 29, Month: 2, Year: yr(2023)}, // not a leap year
		{Day: 1, Month: 13},
		{Day: 1, Month: 0},
		{Day: 1, Month: 1, Year: yr(1899)},
		{Day: 1, Month: 1, Year: yr(2027)},
		{Day: 29, Month: 9, Year: yr(2026)}, // tomorrow
	}
	for _, b := range bad {
		if Validate(b, now) == nil {
			t.Errorf("%v: accepted", b)
		}
	}
}

func TestIsTodayByZone(t *testing.T) {
	// 22:30 UTC on 14 March = 01:30 on 15 March in Moscow (UTC+3), 12:30 in Honolulu (UTC-10).
	now := time.Date(2026, 3, 14, 22, 30, 0, 0, time.UTC)
	msk, _ := time.LoadLocation("Europe/Moscow")
	hnl, _ := time.LoadLocation("Pacific/Honolulu")
	if !IsToday(15, 3, now.In(msk)) || IsToday(14, 3, now.In(msk)) {
		t.Error("Moscow: 15 March")
	}
	if !IsToday(14, 3, now.In(hnl)) || IsToday(15, 3, now.In(hnl)) {
		t.Error("Honolulu: 14 March")
	}
	if !IsToday(14, 3, now.In(Zone(nil))) {
		t.Error("no zone = UTC")
	}
	bad := "Nowhere/Zone"
	if Zone(&bad) != time.UTC {
		t.Error("unknown zone = UTC")
	}
}

func TestFebruary29(t *testing.T) {
	// Common year: celebrated on 28 February, not on 1 March.
	if !IsToday(29, 2, time.Date(2027, 2, 28, 10, 0, 0, 0, time.UTC)) {
		t.Error("2027-02-28 should celebrate 29 February")
	}
	if IsToday(29, 2, time.Date(2027, 3, 1, 10, 0, 0, 0, time.UTC)) {
		t.Error("2027-03-01 should not")
	}
	// Leap year: on the day itself only.
	if IsToday(29, 2, time.Date(2028, 2, 28, 10, 0, 0, 0, time.UTC)) || !IsToday(29, 2, time.Date(2028, 2, 29, 10, 0, 0, 0, time.UTC)) {
		t.Error("2028: 29 February only")
	}
	if got := DaysUntil(29, 2, time.Date(2027, 2, 25, 0, 0, 0, 0, time.UTC)); got != 3 {
		t.Errorf("DaysUntil 29.02 from 2027-02-25 = %d, want 3", got)
	}
	if !slices.Contains(candidateKeys(time.Date(2027, 2, 28, 12, 0, 0, 0, time.UTC)), 229) {
		t.Error("candidate keys of 2027-02-28 must include 29 February")
	}
	if !slices.Contains(candidateKeys(time.Date(2028, 2, 28, 12, 0, 0, 0, time.UTC)), 229) {
		t.Error("2028-02-28: 29 February is tomorrow in UTC, a candidate too")
	}
}

func TestDaysUntil(t *testing.T) {
	today := time.Date(2026, 12, 29, 23, 0, 0, 0, time.UTC)
	cases := []struct{ d, m, want int }{
		{29, 12, 0},
		{30, 12, 1},
		{2, 1, 4},     // over the new year
		{28, 12, 364}, // yesterday: next year
	}
	for _, c := range cases {
		if got := DaysUntil(c.d, c.m, today); got != c.want {
			t.Errorf("DaysUntil(%d.%d) = %d, want %d", c.d, c.m, got, c.want)
		}
	}
}

func TestCandidateKeys(t *testing.T) {
	got := candidateKeys(time.Date(2026, 1, 1, 0, 30, 0, 0, time.UTC))
	for _, k := range []int32{1231, 101, 102} {
		if !slices.Contains(got, k) {
			t.Errorf("missing %d in %v", k, got)
		}
	}
}
