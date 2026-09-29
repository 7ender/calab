package calendar

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func mustLoc(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

func starts(occ []Occurrence, loc *time.Location) []string {
	out := make([]string, len(occ))
	for i, o := range occ {
		out[i] = o.Start.In(loc).Format("2006-01-02 15:04") + "/" + o.End.Sub(o.Start).String()
	}
	return out
}

func TestRuleRoundTrip(t *testing.T) {
	until := time.Date(2026, 12, 31, 20, 59, 59, 0, time.UTC)
	for _, r := range []Rule{
		{},
		{Repeat: v1.EventRepeat_EVENT_REPEAT_DAILY},
		{Repeat: v1.EventRepeat_EVENT_REPEAT_WEEKLY, Until: &until},
		{Repeat: v1.EventRepeat_EVENT_REPEAT_BIWEEKLY, Until: &until},
		{Repeat: v1.EventRepeat_EVENT_REPEAT_MONTHLY},
	} {
		got, err := ParseRule(r.String())
		if err != nil || got.Repeat != r.Repeat || (r.Until == nil) != (got.Until == nil) || (r.Until != nil && !got.Until.Equal(*r.Until)) {
			t.Errorf("%q: %+v %v", r.String(), got, err)
		}
	}
	if s := (Rule{Repeat: v1.EventRepeat_EVENT_REPEAT_BIWEEKLY, Until: &until}).String(); s != "FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T205959Z" {
		t.Errorf("biweekly: %q", s)
	}
	for _, bad := range []string{"FREQ=YEARLY", "FREQ=WEEKLY;INTERVAL=3", "FREQ=DAILY;BYDAY=MO", "FREQ=DAILY;UNTIL=2026", "junk"} {
		if _, err := ParseRule(bad); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestExpandDailyWeeklyUntil(t *testing.T) {
	msk := mustLoc(t, "Europe/Moscow")
	start := time.Date(2026, 10, 5, 10, 0, 0, 0, msk) // Monday
	until := time.Date(2026, 10, 8, 10, 0, 0, 0, msk)
	s := Series{Start: start.UTC(), End: start.Add(30 * time.Minute).UTC(), Loc: msk,
		Rule: Rule{Repeat: v1.EventRepeat_EVENT_REPEAT_DAILY, Until: &until}}
	got := starts(s.Between(start.AddDate(0, 0, -3), start.AddDate(0, 1, 0)), msk)
	want := []string{"2026-10-05 10:00/30m0s", "2026-10-06 10:00/30m0s", "2026-10-07 10:00/30m0s", "2026-10-08 10:00/30m0s"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("daily: %v", got)
	}
	// A window in the middle skips ahead; an occurrence overlapping `from` is included.
	got = starts(s.Between(time.Date(2026, 10, 7, 10, 15, 0, 0, msk), time.Date(2026, 10, 7, 23, 0, 0, 0, msk)), msk)
	if len(got) != 1 || got[0] != "2026-10-07 10:00/30m0s" {
		t.Errorf("overlap: %v", got)
	}
	// Exceptions are skipped.
	s.Except = map[int64]bool{time.Date(2026, 10, 6, 10, 0, 0, 0, msk).Unix(): true}
	if n := len(s.Between(start, start.AddDate(0, 1, 0))); n != 3 {
		t.Errorf("with exception: %d", n)
	}
	if !s.IsOccurrence(time.Date(2026, 10, 6, 7, 0, 0, 0, time.UTC)) || s.IsOccurrence(time.Date(2026, 10, 6, 7, 5, 0, 0, time.UTC)) {
		t.Error("IsOccurrence")
	}

	w := Series{Start: start.UTC(), End: start.Add(time.Hour).UTC(), Loc: msk, Rule: Rule{Repeat: v1.EventRepeat_EVENT_REPEAT_WEEKLY}}
	got = starts(w.Between(time.Date(2027, 3, 1, 0, 0, 0, 0, msk), time.Date(2027, 3, 20, 0, 0, 0, 0, msk)), msk)
	if strings.Join(got, ",") != "2027-03-01 10:00/1h0m0s,2027-03-08 10:00/1h0m0s,2027-03-15 10:00/1h0m0s" {
		t.Errorf("weekly far ahead: %v", got)
	}
	bw := Series{Start: start.UTC(), End: start.Add(time.Hour).UTC(), Loc: msk, Rule: Rule{Repeat: v1.EventRepeat_EVENT_REPEAT_BIWEEKLY}}
	got = starts(bw.Between(start, start.AddDate(0, 0, 43)), msk)
	if strings.Join(got, ",") != "2026-10-05 10:00/1h0m0s,2026-10-19 10:00/1h0m0s,2026-11-02 10:00/1h0m0s,2026-11-16 10:00/1h0m0s" {
		t.Errorf("biweekly: %v", got)
	}
}

func TestExpandMonthlySkipsShortMonths(t *testing.T) {
	loc := mustLoc(t, "Europe/Berlin")
	start := time.Date(2026, 1, 31, 9, 0, 0, 0, loc)
	until := time.Date(2026, 8, 1, 0, 0, 0, 0, loc)
	s := Series{Start: start.UTC(), End: start.Add(time.Hour).UTC(), Loc: loc, Rule: Rule{Repeat: v1.EventRepeat_EVENT_REPEAT_MONTHLY, Until: &until}}
	got := starts(s.Between(start, start.AddDate(1, 0, 0)), loc)
	want := "2026-01-31 09:00/1h0m0s,2026-03-31 09:00/1h0m0s,2026-05-31 09:00/1h0m0s,2026-07-31 09:00/1h0m0s"
	if strings.Join(got, ",") != want {
		t.Errorf("monthly: %v", got)
	}
	// A window a year later skips by months.
	s.Rule.Until = nil
	got = starts(s.Between(time.Date(2027, 5, 1, 0, 0, 0, 0, loc), time.Date(2027, 6, 1, 0, 0, 0, 0, loc)), loc)
	if len(got) != 1 || got[0] != "2027-05-31 09:00/1h0m0s" {
		t.Errorf("monthly later: %v", got)
	}
}

// Across DST (Berlin, 2026-03-29 and 2026-10-25) a weekly 10:00 meeting stays at 10:00 local
// and keeps its duration; an all-day event keeps whole days.
func TestExpandAcrossDST(t *testing.T) {
	loc := mustLoc(t, "Europe/Berlin")
	start := time.Date(2026, 3, 22, 10, 0, 0, 0, loc)
	s := Series{Start: start.UTC(), End: start.Add(90 * time.Minute).UTC(), Loc: loc, Rule: Rule{Repeat: v1.EventRepeat_EVENT_REPEAT_WEEKLY}}
	occ := s.Between(start, start.AddDate(0, 0, 14))
	if len(occ) != 2 {
		t.Fatalf("occurrences: %d", len(occ))
	}
	if occ[0].Start.UTC().Hour() != 9 || occ[1].Start.UTC().Hour() != 8 || occ[1].Start.In(loc).Hour() != 10 || occ[1].End.Sub(occ[1].Start) != 90*time.Minute {
		t.Errorf("DST: %v", starts(occ, loc))
	}
	day := time.Date(2026, 10, 24, 0, 0, 0, 0, loc)
	ad := Series{Start: day.UTC(), End: day.AddDate(0, 0, 1).UTC(), AllDay: true, Loc: loc, Rule: Rule{Repeat: v1.EventRepeat_EVENT_REPEAT_DAILY}}
	occ = ad.Between(day, day.AddDate(0, 0, 3))
	if len(occ) != 3 || occ[1].End.Sub(occ[1].Start) != 25*time.Hour || occ[1].End.In(loc).Hour() != 0 || occ[2].Start.In(loc).Day() != 26 {
		t.Errorf("all-day DST: %v", starts(occ, loc))
	}
	// Active window: 15 min before the start until the end.
	o := occ[0]
	if !o.Active(o.Start.Add(-15*time.Minute)) || o.Active(o.Start.Add(-16*time.Minute)) || o.Active(o.End) {
		t.Error("active window")
	}
}

// A series started long ago expands like a brute-force walk from its first occurrence: the
// skip-ahead never drops occurrences (a 23 h "period" lost a daily meeting's occurrences
// after ~7 weeks), across DST, for multi-day meetings and all four repeats.
func TestExpandOldSeriesMatchesBruteForce(t *testing.T) {
	brute := func(s Series, from, to time.Time) []Occurrence {
		var out []Occurrence
		for n := 0; n < 100000; n++ {
			o, ok := s.nth(n)
			if !ok {
				continue
			}
			if !o.Start.Before(to) {
				break
			}
			if o.End.After(from) {
				out = append(out, o)
			}
		}
		return out
	}
	for _, zone := range []string{"UTC", "Europe/Berlin", "America/New_York", "Australia/Lord_Howe"} {
		loc := mustLoc(t, zone)
		for _, rep := range []v1.EventRepeat{v1.EventRepeat_EVENT_REPEAT_DAILY, v1.EventRepeat_EVENT_REPEAT_WEEKLY,
			v1.EventRepeat_EVENT_REPEAT_BIWEEKLY, v1.EventRepeat_EVENT_REPEAT_MONTHLY} {
			for _, dur := range []time.Duration{30 * time.Minute, 50 * time.Hour, 7 * 24 * time.Hour} {
				start := time.Date(2021, 1, 31, 23, 30, 0, 0, loc)
				s := Series{Start: start.UTC(), End: start.Add(dur).UTC(), Loc: loc, Rule: Rule{Repeat: rep}}
				for _, from := range []time.Time{
					time.Date(2021, 3, 20, 0, 0, 0, 0, loc), time.Date(2026, 9, 1, 0, 0, 0, 0, loc),
					time.Date(2031, 10, 26, 1, 0, 0, 0, loc), time.Date(2034, 2, 28, 12, 0, 0, 0, loc),
				} {
					to := from.Add(MaxListWindow)
					got, want := starts(s.Between(from, to), loc), starts(brute(s, from, to), loc)
					if strings.Join(got, ",") != strings.Join(want, ",") {
						t.Errorf("%s %v %v from %v: got %d occurrences, want %d", zone, rep, dur, from, len(got), len(want))
					}
				}
			}
		}
	}
}

// TEXT escaping: the separators and line breaks are escaped, other control characters (a CR
// alone could end the content line) are dropped.
func TestICSText(t *testing.T) {
	in := "a;b,c\\d\r\nnext\rX\x00\x0bY\tZ\x7f"
	if got, want := icsText(in), `a\;b\,c\\d\nnextXY`+"\tZ"; got != want {
		t.Errorf("icsText = %q, want %q", got, want)
	}
}

// parseICS is a minimal RFC 5545 reader for the tests: CRLF lines of ≤ 75 octets, unfolding,
// balanced BEGIN / END, NAME[;PARAMS]:VALUE. It returns the properties of the VEVENT.
func parseICS(t *testing.T, s string) map[string][]string {
	t.Helper()
	if !strings.HasSuffix(s, "\r\n") {
		t.Fatal("no final CRLF")
	}
	var lines []string
	for _, l := range strings.Split(strings.TrimSuffix(s, "\r\n"), "\r\n") {
		if len(l) > 75 {
			t.Fatalf("line over 75 octets: %q", l)
		}
		if strings.ContainsAny(l, "\r\n") {
			t.Fatalf("bare CR/LF in %q", l)
		}
		if strings.HasPrefix(l, " ") {
			lines[len(lines)-1] += l[1:]
			continue
		}
		lines = append(lines, l)
	}
	var stack []string
	props := map[string][]string{}
	for _, l := range lines {
		name, value, ok := strings.Cut(l, ":")
		if !ok || name == "" {
			t.Fatalf("bad line %q", l)
		}
		switch name {
		case "BEGIN":
			stack = append(stack, value)
			continue
		case "END":
			if len(stack) == 0 || stack[len(stack)-1] != value {
				t.Fatalf("unbalanced END:%s", value)
			}
			stack = stack[:len(stack)-1]
			continue
		}
		if len(stack) > 0 && stack[len(stack)-1] == "VEVENT" || len(stack) == 1 {
			props[name] = append(props[name], value)
		}
	}
	if len(stack) != 0 {
		t.Fatalf("unclosed %v", stack)
	}
	return props
}

func TestBuildICS(t *testing.T) {
	msk := mustLoc(t, "Europe/Moscow")
	start := time.Date(2026, 10, 5, 15, 0, 0, 0, msk)
	id := uuid.MustParse("01890000-0000-7000-8000-000000000001")
	e := ICSEvent{
		UID: id.String() + "@calab", Sequence: 2, Method: MethodRequest, Stamp: start,
		Series: Series{Start: start.UTC(), End: start.Add(time.Hour).UTC(), Loc: msk},
		Title:  "Планёрка; итоги, план", Description: strings.Repeat("Длинное описание с юникодом. ", 10) + "\nвторая строка",
		Location: "Calab: Переговорка", URL: "https://app.example.com/e/" + id.String(),
		Organizer: ICSPerson{Name: `Ann "the boss"`, Email: "ann@example.com"},
		Attendees: []ICSPerson{{Name: "Bob", Email: "bob@example.com"}, {Email: "guest@outside.org", Optional: true, PartStat: "ACCEPTED"}},
	}
	p := parseICS(t, BuildICS(e))
	check := func(name, want string) {
		t.Helper()
		if len(p[name]) == 0 || p[name][0] != want {
			t.Errorf("%s = %q, want %q", name, p[name], want)
		}
	}
	check("METHOD", "REQUEST")
	check("UID", id.String()+"@calab")
	check("SEQUENCE", "2")
	check("DTSTART", "20261005T120000Z")
	check("DTEND", "20261005T130000Z")
	check("SUMMARY", `Планёрка\; итоги\, план`)
	check("URL", e.URL)
	check("STATUS", "CONFIRMED")
	check(`ORGANIZER;CN="Ann the boss"`, "mailto:ann@example.com")
	if d := p["DESCRIPTION"]; len(d) != 1 || !strings.HasSuffix(d[0], `\nвторая строка`) {
		t.Errorf("DESCRIPTION %q", d)
	}
	att := p[`ATTENDEE;CN="Bob";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE`]
	ext := p["ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE"]
	if len(att) != 1 || att[0] != "mailto:bob@example.com" || len(ext) != 1 || ext[0] != "mailto:guest@outside.org" {
		t.Errorf("attendees %v", p)
	}

	// Cancel of a weekly series in a DST zone: TZID + VTIMEZONE, RRULE with UTC UNTIL, EXDATE.
	ber := mustLoc(t, "Europe/Berlin")
	bs := time.Date(2026, 3, 16, 10, 0, 0, 0, ber)
	until := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	e.Method, e.Series = MethodCancel, Series{Start: bs.UTC(), End: bs.Add(time.Hour).UTC(), Loc: ber,
		Rule: Rule{Repeat: v1.EventRepeat_EVENT_REPEAT_WEEKLY, Until: &until}, Except: map[int64]bool{bs.AddDate(0, 0, 7).Unix(): true}}
	raw := BuildICS(e)
	p = parseICS(t, raw)
	check("METHOD", "CANCEL")
	check("STATUS", "CANCELLED")
	check("DTSTART;TZID=Europe/Berlin", "20260316T100000")
	check("RRULE", "FREQ=WEEKLY;UNTIL=20260601T000000Z")
	check("EXDATE;TZID=Europe/Berlin", "20260323T100000")
	for _, want := range []string{"BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "BEGIN:DAYLIGHT", "TZOFFSETTO:+0200", "BEGIN:STANDARD",
		"TZOFFSETTO:+0100", "RDATE:20260329T020000", "RDATE:20261025T030000"} {
		if !strings.Contains(raw, want+"\r\n") && !strings.Contains(raw, want) {
			t.Errorf("no %q in\n%s", want, raw)
		}
	}
	// All-day: DATE values.
	e.Method = MethodRequest
	day := time.Date(2026, 10, 5, 0, 0, 0, 0, msk)
	e.Series = Series{Start: day.UTC(), End: day.AddDate(0, 0, 1).UTC(), AllDay: true, Loc: msk}
	p = parseICS(t, BuildICS(e))
	check("DTSTART;VALUE=DATE", "20261005")
	check("DTEND;VALUE=DATE", "20261006")
}

func TestRSVPToken(t *testing.T) {
	key := tokenKey([]byte("secret-secret-secret"))
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	c := rsvpClaims{Event: uuid.New(), Status: StatusMaybe, Email: "guest@outside.org", Exp: now.Add(time.Hour)}
	tok := signRSVP(key, c)
	got, err := verifyRSVP(key, tok, now)
	if err != nil || got.Event != c.Event || got.Status != StatusMaybe || got.Email != c.Email || !got.Exp.Equal(c.Exp) {
		t.Fatalf("verify: %+v %v", got, err)
	}
	if _, err := verifyRSVP(key, tok, now.Add(2*time.Hour)); err != errTokenExpired {
		t.Errorf("expired: %v", err)
	}
	if _, err := verifyRSVP(tokenKey([]byte("other")), tok, now); err != errTokenInvalid {
		t.Errorf("other key: %v", err)
	}
	b := []byte(tok)
	b[len(b)/2] ^= 1
	if _, err := verifyRSVP(key, string(b), now); err != errTokenInvalid {
		t.Errorf("tampered: %v", err)
	}
	if _, err := verifyRSVP(key, "", now); err != errTokenInvalid {
		t.Errorf("empty: %v", err)
	}
	// A view token (the meeting link of the mail) round-trips with its own status and differs
	// from every answer token of the same address.
	v := c
	v.Status = statusView
	vt := signRSVP(key, v)
	if got, err := verifyRSVP(key, vt, now); err != nil || got.Status != statusView || got.Email != c.Email {
		t.Fatalf("view: %+v %v", got, err)
	}
	seen := map[string]bool{vt: true}
	for _, st := range []string{StatusAccepted, StatusDeclined, StatusMaybe} {
		a := c
		a.Status = st
		at := signRSVP(key, a)
		if seen[at] {
			t.Errorf("%s token equals another", st)
		}
		seen[at] = true
	}
	// An unknown status byte is invalid even with a valid signature.
	raw, _ := base64.RawURLEncoding.DecodeString(vt)
	body := raw[:len(raw)-macLen]
	body[16] = 9
	m := hmac.New(sha256.New, key)
	m.Write(body)
	forged := base64.RawURLEncoding.EncodeToString(m.Sum(slices.Clone(body))[:len(body)+macLen])
	if _, err := verifyRSVP(key, forged, now); err != errTokenInvalid {
		t.Errorf("unknown status: %v", err)
	}
}

func TestFormatWhen(t *testing.T) {
	msk := mustLoc(t, "Europe/Moscow")
	o := Occurrence{time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC), time.Date(2026, 10, 5, 13, 30, 0, 0, time.UTC)}
	if d, w := formatWhen("ru", o, false, msk); d != "05.10.2026" || w != "05.10.2026 15:00–16:30 (Europe/Moscow)" {
		t.Errorf("ru: %q %q", d, w)
	}
	day := Occurrence{time.Date(2026, 10, 4, 21, 0, 0, 0, time.UTC), time.Date(2026, 10, 6, 21, 0, 0, 0, time.UTC)}
	if _, w := formatWhen("en", day, true, msk); w != "2026-10-05 – 2026-10-06" {
		t.Errorf("all-day: %q", w)
	}
}
