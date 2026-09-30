package calendar

import (
	"slices"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Free / busy math (ADR-0041 §1–2): working hours, all-day meetings in a person's zone,
// interval merging and the slot search. Pure functions over UTC instants.

// Limits of free / busy and suggestions.
const (
	MaxBusyUsers    = 20
	MaxBusyWindow   = 14 * 24 * time.Hour
	MaxSuggestions  = 10
	SlotStep        = 15 * time.Minute
	MinSlotDuration = 5 // minutes
	MaxSlotDuration = 24 * 60
)

// WorkHours are a person's working hours in Loc: [Start, End) minutes from local midnight on
// Days (1 = Monday … 7 = Sunday).
type WorkHours struct {
	Start, End int
	Days       []int
	Loc        *time.Location
}

// Default working hours: 10:00–19:00, Monday to Friday.
const (
	DefaultWorkStart = 10 * 60
	DefaultWorkEnd   = 19 * 60
)

// ValidateWorkHours checks UpdateMeRequest.work_hours and returns the columns (days distinct
// and sorted).
func ValidateWorkHours(w *v1.WorkHours) (start, end int16, days []int16, err error) {
	if w.GetStartMin() >= w.GetEndMin() || w.GetEndMin() > 24*60 {
		return 0, 0, nil, httpx.Validation("workHours", "working hours: start before end, end at most 24:00")
	}
	for _, d := range w.GetDays() {
		if d < 1 || d > 7 {
			return 0, 0, nil, httpx.Validation("workHours.days", "days are 1 (Monday) … 7 (Sunday)")
		}
		if !slices.Contains(days, int16(d)) { //nolint:gosec // 1..7
			days = append(days, int16(d)) //nolint:gosec // 1..7
		}
	}
	if len(days) == 0 {
		return 0, 0, nil, httpx.Validation("workHours.days", "at least one working day")
	}
	slices.Sort(days)
	return int16(w.GetStartMin()), int16(w.GetEndMin()), days, nil //nolint:gosec // ≤ 1440
}

// WorkHoursProto converts the users columns.
func WorkHoursProto(start, end int16, days []int16) *v1.WorkHours {
	out := &v1.WorkHours{StartMin: uint32(max(start, 0)), EndMin: uint32(max(end, 0)), Days: make([]uint32, 0, len(days))} //nolint:gosec // ≤ 1440
	for _, d := range days {
		out.Days = append(out.Days, uint32(max(d, 0))) //nolint:gosec // 1..7
	}
	return out
}

// isoWeekday: 1 = Monday … 7 = Sunday.
func isoWeekday(t time.Time) int {
	if wd := int(t.Weekday()); wd != 0 {
		return wd
	}
	return 7
}

// Intervals returns the working intervals overlapping [from, to), clipped to it, in order.
// Wall-clock times follow the zone's DST (a 10:00 start stays 10:00).
func (w WorkHours) Intervals(from, to time.Time) []Occurrence {
	loc := w.Loc
	if loc == nil {
		loc = time.UTC
	}
	var out []Occurrence
	y, m, d := from.In(loc).Date()
	for i := -1; ; i++ {
		day := time.Date(y, m, d+i, 0, 0, 0, 0, loc)
		if !day.Before(to) {
			break
		}
		if !slices.Contains(w.Days, isoWeekday(day)) {
			continue
		}
		dy, dm, dd := day.Date()
		st := time.Date(dy, dm, dd, 0, w.Start, 0, 0, loc)
		en := time.Date(dy, dm, dd, 0, w.End, 0, 0, loc)
		if st.Before(from) {
			st = from
		}
		if en.After(to) {
			en = to
		}
		if en.After(st) {
			out = append(out, Occurrence{st.UTC(), en.UTC()})
		}
	}
	return out
}

// AllDayIn maps an all-day occurrence (midnight to midnight of evLoc) onto the same calendar
// days in loc: an all-day meeting keeps a person busy for those days of their own zone.
func AllDayIn(o Occurrence, evLoc, loc *time.Location) Occurrence {
	sy, sm, sd := o.Start.In(evLoc).Date()
	ey, em, ed := o.End.In(evLoc).Date()
	return Occurrence{time.Date(sy, sm, sd, 0, 0, 0, 0, loc).UTC(), time.Date(ey, em, ed, 0, 0, 0, 0, loc).UTC()}
}

// Merge sorts intervals and joins the overlapping or touching ones.
func Merge(in []Occurrence) []Occurrence {
	if len(in) == 0 {
		return nil
	}
	s := slices.Clone(in)
	slices.SortFunc(s, func(a, b Occurrence) int { return a.Start.Compare(b.Start) })
	out := []Occurrence{s[0]}
	for _, o := range s[1:] {
		last := &out[len(out)-1]
		if !o.Start.After(last.End) {
			if o.End.After(last.End) {
				last.End = o.End
			}
			continue
		}
		out = append(out, o)
	}
	return out
}

// Intersect returns the common parts of two merged, sorted lists.
func Intersect(a, b []Occurrence) []Occurrence {
	var out []Occurrence
	for i, j := 0, 0; i < len(a) && j < len(b); {
		st, en := a[i].Start, a[i].End
		if b[j].Start.After(st) {
			st = b[j].Start
		}
		if b[j].End.Before(en) {
			en = b[j].End
		}
		if en.After(st) {
			out = append(out, Occurrence{st, en})
		}
		if a[i].End.Before(b[j].End) {
			i++
		} else {
			j++
		}
	}
	return out
}

// SlotQuery is what the slot search needs.
type SlotQuery struct {
	From, To time.Time     // the window; slots start at or after From and end by To
	Duration time.Duration // of a slot
	Busy     []Occurrence  // everyone's busy time and the room's meetings (any order)
	// Allowed limits slots to these intervals (the common working hours); nil = anywhere.
	Allowed []Occurrence
	Limit   int
}

// FindSlots returns up to q.Limit earliest slots on the SlotStep grid (UTC-aligned) that lie
// inside one allowed interval and overlap no busy interval.
func FindSlots(q SlotQuery) []Occurrence {
	busy := Merge(q.Busy)
	var allowed []Occurrence
	if q.Allowed != nil {
		allowed = Merge(q.Allowed)
	} else {
		allowed = []Occurrence{{q.From, q.To}}
	}
	var out []Occurrence
	bi := 0
	for _, a := range allowed {
		st := a.Start
		if st.Before(q.From) {
			st = q.From
		}
		en := a.End
		if en.After(q.To) {
			en = q.To
		}
		t := ceilStep(st)
		for !t.Add(q.Duration).After(en) {
			slot := Occurrence{t, t.Add(q.Duration)}
			for bi < len(busy) && !busy[bi].End.After(slot.Start) {
				bi++ // busy intervals ending by this slot's start can no longer overlap
			}
			if bi < len(busy) && busy[bi].Start.Before(slot.End) {
				t = ceilStep(busy[bi].End) // jump past the conflict
				continue
			}
			out = append(out, slot)
			if len(out) >= q.Limit {
				return out
			}
			t = t.Add(SlotStep)
		}
	}
	return out
}

// ceilStep rounds t up to the SlotStep grid.
func ceilStep(t time.Time) time.Time {
	r := t.Truncate(SlotStep)
	if r.Before(t) {
		r = r.Add(SlotStep)
	}
	return r
}
