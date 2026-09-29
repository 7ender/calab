package calendar

import (
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func occ(a, b time.Time) Occurrence { return Occurrence{a.UTC(), b.UTC()} }

func TestMergeIntersect(t *testing.T) {
	h := func(n int) time.Time { return time.Date(2026, 10, 1, n, 0, 0, 0, time.UTC) }
	m := Merge([]Occurrence{occ(h(5), h(6)), occ(h(1), h(3)), occ(h(2), h(4)), occ(h(4), h(5))})
	if len(m) != 1 || !m[0].Start.Equal(h(1)) || !m[0].End.Equal(h(6)) {
		t.Fatalf("merge %v", m)
	}
	i := Intersect([]Occurrence{occ(h(1), h(4)), occ(h(6), h(9))}, []Occurrence{occ(h(3), h(7)), occ(h(8), h(10))})
	want := []Occurrence{occ(h(3), h(4)), occ(h(6), h(7)), occ(h(8), h(9))}
	if len(i) != len(want) {
		t.Fatalf("intersect %v", i)
	}
	for k := range want {
		if i[k] != want[k] {
			t.Errorf("%d: %v want %v", k, i[k], want[k])
		}
	}
	if len(Intersect(nil, want)) != 0 {
		t.Error("intersect with nothing")
	}
}

func TestWorkHoursAcrossDST(t *testing.T) {
	berlin := loadZone("Europe/Berlin")
	w := WorkHours{Start: 10 * 60, End: 19 * 60, Days: []int{1, 2, 3, 4, 5}, Loc: berlin}
	// Fri 23 Oct … Tue 27 Oct 2026 (DST ends Sun 25 Oct).
	iv := w.Intervals(time.Date(2026, 10, 23, 0, 0, 0, 0, berlin), time.Date(2026, 10, 28, 0, 0, 0, 0, berlin))
	if len(iv) != 3 {
		t.Fatalf("intervals %v", iv)
	}
	if iv[0].Start.Hour() != 8 || iv[1].Start.Hour() != 9 || iv[1].Start.Day() != 26 || iv[2].End.Hour() != 18 {
		t.Errorf("wall clock: %v", iv)
	}
	// Clipped to the window.
	iv = w.Intervals(time.Date(2026, 10, 23, 12, 0, 0, 0, berlin), time.Date(2026, 10, 23, 15, 0, 0, 0, berlin))
	if len(iv) != 1 || iv[0].End.Sub(iv[0].Start) != 3*time.Hour {
		t.Errorf("clip %v", iv)
	}
	// Till midnight.
	late := WorkHours{Start: 22 * 60, End: 24 * 60, Days: []int{6}, Loc: time.UTC}
	iv = late.Intervals(time.Date(2026, 10, 24, 0, 0, 0, 0, time.UTC), time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC))
	if len(iv) != 1 || !iv[0].End.Equal(time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("24:00 %v", iv)
	}
}

func TestAllDayInZone(t *testing.T) {
	msk, ny := loadZone("Europe/Moscow"), loadZone("America/New_York")
	o := occ(time.Date(2026, 9, 30, 0, 0, 0, 0, msk), time.Date(2026, 10, 1, 0, 0, 0, 0, msk))
	got := AllDayIn(o, msk, ny)
	if !got.Start.Equal(time.Date(2026, 9, 30, 0, 0, 0, 0, ny)) || !got.End.Equal(time.Date(2026, 10, 1, 0, 0, 0, 0, ny)) {
		t.Errorf("all day in NY: %v", got)
	}
}

func TestFindSlots(t *testing.T) {
	day := func(h, m int) time.Time { return time.Date(2026, 10, 5, h, m, 0, 0, time.UTC) }
	q := SlotQuery{From: day(9, 7), To: day(18, 0), Duration: time.Hour, Limit: 10,
		Busy: []Occurrence{
			occ(day(10, 0), day(11, 0)),   // person A
			occ(day(10, 30), day(11, 20)), // person B, overlapping A
			occ(day(13, 0), day(14, 0)),   // the room
		},
		Allowed: []Occurrence{occ(day(9, 0), day(12, 30)), occ(day(13, 0), day(18, 0))}}
	got := FindSlots(q)
	want := []time.Time{day(11, 30), day(14, 0), day(14, 15), day(14, 30), day(14, 45), day(15, 0), day(15, 15), day(15, 30), day(15, 45), day(16, 0)}
	if len(got) != len(want) {
		t.Fatalf("slots %v", got)
	}
	for i, w := range want {
		if !got[i].Start.Equal(w) || got[i].End.Sub(got[i].Start) != time.Hour {
			t.Errorf("%d: %v, want %v", i, got[i].Start, w)
		}
	}
	// 9:07 → the grid starts at 9:15, but 9:15–10:15 hits A: none before 11:30.
	q.Limit, q.Allowed = 3, nil
	q.From = day(8, 0)
	got = FindSlots(q)
	if len(got) != 3 || !got[0].Start.Equal(day(8, 0)) || !got[2].Start.Equal(day(8, 30)) {
		t.Errorf("anywhere: %v", got)
	}
	// Fully busy.
	q.Busy = []Occurrence{occ(day(0, 0), day(23, 0))}
	if got := FindSlots(q); len(got) != 0 {
		t.Errorf("busy day: %v", got)
	}
}

func TestSlotsAcrossDSTWorkHours(t *testing.T) {
	berlin := loadZone("Europe/Berlin")
	w := WorkHours{Start: 10 * 60, End: 11 * 60, Days: []int{7}, Loc: berlin} // Sundays 10–11
	from, to := time.Date(2026, 10, 24, 0, 0, 0, 0, time.UTC), time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)
	got := FindSlots(SlotQuery{From: from, To: to, Duration: time.Hour, Allowed: w.Intervals(from, to), Limit: 10})
	if len(got) != 1 || !got[0].Start.Equal(time.Date(2026, 10, 25, 9, 0, 0, 0, time.UTC)) {
		t.Errorf("DST Sunday: %v", got) // 10:00 CET = 09:00Z after the change
	}
}

func TestValidateWorkHours(t *testing.T) {
	s, e, d, err := ValidateWorkHours(&v1.WorkHours{StartMin: 540, EndMin: 1080, Days: []uint32{5, 1, 1, 3}})
	if err != nil || s != 540 || e != 1080 || len(d) != 3 || d[0] != 1 || d[2] != 5 {
		t.Fatalf("%d %d %v %v", s, e, d, err)
	}
	for _, bad := range []*v1.WorkHours{
		{StartMin: 600, EndMin: 600, Days: []uint32{1}},
		{StartMin: 600, EndMin: 1441, Days: []uint32{1}},
		{StartMin: 600, EndMin: 700},
		{StartMin: 600, EndMin: 700, Days: []uint32{8}},
		{StartMin: 600, EndMin: 700, Days: []uint32{0}},
	} {
		if _, _, _, err := ValidateWorkHours(bad); err == nil {
			t.Errorf("accepted %v", bad)
		}
	}
}

func TestICSWithoutMethodAndOrganizer(t *testing.T) {
	s := Series{Start: time.Date(2026, 10, 5, 9, 0, 0, 0, time.UTC), End: time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC), Loc: time.UTC}
	out := BuildICS(ICSEvent{UID: "x@calab", Series: s, Title: "t", Stamp: s.Start})
	for _, bad := range []string{"METHOD:", "ORGANIZER", "ATTENDEE"} {
		if strings.Contains(out, bad) {
			t.Errorf("%s in CalDAV object:\n%s", bad, out)
		}
	}
}
