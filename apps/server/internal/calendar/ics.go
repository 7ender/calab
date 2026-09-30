package calendar

import (
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// ICS methods (RFC 5546).
const (
	MethodRequest = "REQUEST"
	MethodCancel  = "CANCEL"
)

// ICSPerson is an ORGANIZER / ATTENDEE of an invitation.
type ICSPerson struct {
	Name     string
	Email    string
	Optional bool   // ATTENDEE ROLE=OPT-PARTICIPANT
	PartStat string // NEEDS-ACTION | ACCEPTED | DECLINED | TENTATIVE; "" = NEEDS-ACTION
}

// ICSEvent is what an invitation describes (ADR-0038 §4).
type ICSEvent struct {
	UID         string // <event id>@calab
	Sequence    int
	Method      string // "" = none (a CalDAV object)
	Series      Series
	Title       string
	Description string
	Location    string
	URL         string
	Organizer   ICSPerson
	Attendees   []ICSPerson
	Stamp       time.Time
}

const icsDate, icsUTC, icsLocal = "20060102", "20060102T150405Z", "20060102T150405"

// BuildICS renders a VCALENDAR with one VEVENT (CRLF lines folded at 75 octets). Times are UTC,
// except a repeating timed series in a zone with DST: its DTSTART / DTEND carry the TZID with a
// VTIMEZONE (the transitions of ten years), so calendars keep its wall-clock time.
func BuildICS(e ICSEvent) string {
	var b strings.Builder
	line := func(s string) { b.WriteString(fold(s)) }
	s := e.Series
	line("BEGIN:VCALENDAR")
	line("VERSION:2.0")
	line("PRODID:-//Calab//Calendar//EN")
	line("CALSCALE:GREGORIAN")
	if e.Method != "" { // a CalDAV object resource has no METHOD (RFC 4791 §4.1)
		line("METHOD:" + e.Method)
	}
	var tzid string
	if !s.AllDay && s.Rule.Repeat != 0 {
		if vtz, ok := vtimezone(s.Loc, s.Start); ok {
			tzid = s.Loc.String()
			for _, l := range vtz {
				line(l)
			}
		}
	}
	line("BEGIN:VEVENT")
	line("UID:" + e.UID)
	line("SEQUENCE:" + fmt.Sprint(e.Sequence))
	line("DTSTAMP:" + e.Stamp.UTC().Format(icsUTC))
	switch {
	case s.AllDay:
		line("DTSTART;VALUE=DATE:" + s.Start.In(s.Loc).Format(icsDate))
		line("DTEND;VALUE=DATE:" + s.End.In(s.Loc).Format(icsDate))
	case tzid != "":
		line("DTSTART;TZID=" + tzid + ":" + s.Start.In(s.Loc).Format(icsLocal))
		line("DTEND;TZID=" + tzid + ":" + s.End.In(s.Loc).Format(icsLocal))
	default:
		line("DTSTART:" + s.Start.UTC().Format(icsUTC))
		line("DTEND:" + s.End.UTC().Format(icsUTC))
	}
	if rr := s.Rule.format(s.AllDay, s.Loc); rr != "" {
		line("RRULE:" + rr)
		ex := make([]int64, 0, len(s.Except))
		for k := range s.Except {
			ex = append(ex, k)
		}
		slices.Sort(ex)
		for _, k := range ex {
			t := time.Unix(k, 0)
			switch {
			case s.AllDay:
				line("EXDATE;VALUE=DATE:" + t.In(s.Loc).Format(icsDate))
			case tzid != "":
				line("EXDATE;TZID=" + tzid + ":" + t.In(s.Loc).Format(icsLocal))
			default:
				line("EXDATE:" + t.UTC().Format(icsUTC))
			}
		}
	}
	line("SUMMARY:" + icsText(e.Title))
	if e.Description != "" {
		line("DESCRIPTION:" + icsText(e.Description))
	}
	if e.Location != "" {
		line("LOCATION:" + icsText(e.Location))
	}
	if e.URL != "" {
		line("URL:" + e.URL)
	}
	if e.Method == MethodCancel {
		line("STATUS:CANCELLED")
	} else {
		line("STATUS:CONFIRMED")
	}
	if e.Organizer.Email != "" {
		line("ORGANIZER;CN=" + icsParam(e.Organizer.Name) + ":mailto:" + e.Organizer.Email)
	}
	for _, a := range e.Attendees {
		role := "REQ-PARTICIPANT"
		if a.Optional {
			role = "OPT-PARTICIPANT"
		}
		ps := a.PartStat
		if ps == "" {
			ps = "NEEDS-ACTION"
		}
		cn := ""
		if a.Name != "" {
			cn = ";CN=" + icsParam(a.Name)
		}
		line("ATTENDEE" + cn + ";ROLE=" + role + ";PARTSTAT=" + ps + ";RSVP=TRUE:mailto:" + a.Email)
	}
	line("END:VEVENT")
	line("END:VCALENDAR")
	return b.String()
}

// PartStat maps an attendee status to iCalendar PARTSTAT.
func PartStat(status string) string {
	switch status {
	case StatusAccepted:
		return "ACCEPTED"
	case StatusDeclined:
		return "DECLINED"
	case StatusMaybe:
		return "TENTATIVE"
	}
	return "NEEDS-ACTION"
}

// icsText escapes a TEXT value (RFC 5545 §3.3.11); control characters other than the line
// break and the tab are dropped (TEXT excludes them).
func icsText(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.Map(func(r rune) rune {
		if (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f {
			return -1
		}
		return r
	}, s)
	return strings.NewReplacer(`\`, `\\`, ";", `\;`, ",", `\,`, "\n", `\n`).Replace(s)
}

// icsParam quotes a parameter value; DQUOTE and control characters are dropped.
func icsParam(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '"' || r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	return `"` + s + `"`
}

// fold splits a content line into ≤ 75-octet lines (continuations start with a space),
// never inside a UTF-8 sequence, and ends it with CRLF.
func fold(s string) string {
	var b strings.Builder
	limit := 75
	for len(s) > limit {
		cut := limit
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		b.WriteString(s[:cut] + "\r\n ")
		s = s[cut:]
		limit = 74 // the leading space counts
	}
	b.WriteString(s + "\r\n")
	return b.String()
}

// vtimezone describes loc's UTC offset changes from a year before start to ten years after it
// (STANDARD / DAYLIGHT with RDATEs); false = the offset never changes there (UTC is enough).
func vtimezone(loc *time.Location, start time.Time) ([]string, bool) {
	type change struct {
		at       time.Time // the instant of the change
		from, to int       // offsets in seconds
		name     string
	}
	var changes []change
	t := start.AddDate(-1, 0, 0).UTC().Truncate(24 * time.Hour)
	end := start.AddDate(10, 0, 0)
	_, prev := t.In(loc).Zone()
	for ; t.Before(end); t = t.Add(24 * time.Hour) {
		next := t.Add(24 * time.Hour)
		name, off := next.In(loc).Zone()
		if off == prev {
			continue
		}
		lo, hi := t, next // the change is in (lo, hi]
		for hi.Sub(lo) > time.Second {
			mid := lo.Add(hi.Sub(lo) / 2)
			if _, o := mid.In(loc).Zone(); o == prev {
				lo = mid
			} else {
				hi = mid
			}
		}
		changes = append(changes, change{hi, prev, off, name})
		prev = off
	}
	if len(changes) == 0 {
		return nil, false
	}
	// The larger offset of a pair is daylight time.
	maxOff := changes[0].to
	for _, c := range changes {
		maxOff = max(maxOff, c.to, c.from)
	}
	offset := func(sec int) string {
		sign := "+"
		if sec < 0 {
			sign, sec = "-", -sec
		}
		return fmt.Sprintf("%s%02d%02d", sign, sec/3600, sec%3600/60)
	}
	out := []string{"BEGIN:VTIMEZONE", "TZID:" + loc.String()}
	for _, kind := range []string{"DAYLIGHT", "STANDARD"} {
		var group []change
		for _, c := range changes {
			if (c.to == maxOff) == (kind == "DAYLIGHT") {
				group = append(group, c)
			}
		}
		if len(group) == 0 {
			continue
		}
		// DTSTART / RDATE are local times of the offset in effect before the change.
		local := func(c change) string { return c.at.Add(time.Duration(c.from) * time.Second).UTC().Format(icsLocal) }
		out = append(out, "BEGIN:"+kind, "DTSTART:"+local(group[0]),
			"TZOFFSETFROM:"+offset(group[0].from), "TZOFFSETTO:"+offset(group[0].to), "TZNAME:"+group[0].name)
		for _, c := range group[1:] {
			out = append(out, "RDATE:"+local(c))
		}
		out = append(out, "END:"+kind)
	}
	return append(out, "END:VTIMEZONE"), true
}
