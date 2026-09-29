package calendar

import (
	"context"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// Invitations (ADR-0038 §4, «Дополнение»): one mail per attendee with an address — members with
// a confirmed address, external attendees always — with invite.ics (METHOD REQUEST / CANCEL,
// UID <id>@calab, SEQUENCE). External attendees also get the signed answer links and, with a
// room, their guest link. Mail is best-effort: a refused mail (rate limit, no SMTP) is logged.

// mailTTL: an invitation not delivered within a day is dropped.
const mailTTL = mail.MaxRetry

func (s *Service) eventURL(id uuid.UUID) string {
	return strings.TrimRight(s.cfg.PublicURL, "/") + "/e/" + id.String()
}

// sendMails queues tmpl to the recipients among `to` (attendees of b).
func (s *Service) sendMails(ctx context.Context, b *bundle, tmpl mail.Template, method string, to []sqlc.EventAttendee) {
	if !s.mail.Enabled() || len(to) == 0 {
		return
	}
	ids := []uuid.UUID{b.ev.OrganizerID}
	for _, a := range b.att {
		if a.UserID != nil {
			ids = append(ids, *a.UserID)
		}
	}
	for _, a := range to {
		if a.UserID != nil {
			ids = append(ids, *a.UserID)
		}
	}
	rows, err := s.db.Q.ListEventUsers(ctx, ids)
	if err != nil {
		logErr(ctx, "mail: users", err)
		return
	}
	users := make(map[uuid.UUID]sqlc.ListEventUsersRow, len(rows))
	for _, u := range rows {
		users[u.ID] = u
	}
	org := users[b.ev.OrganizerID]
	roomName := ""
	if b.ev.RoomID != nil {
		if r, err := s.db.Q.GetRoom(ctx, *b.ev.RoomID); err == nil {
			roomName = r.Name
		}
	}
	occ, ok := b.series.Next(s.Now(), lookAhead)
	if !ok {
		occ = Occurrence{b.series.Start, b.series.End}
	}
	ics := BuildICS(s.icsEvent(b, method, users, org, roomName))
	var names []string
	for _, a := range b.att {
		if a.UserID != nil {
			names = append(names, users[*a.UserID].DisplayName)
		} else {
			names = append(names, deref(a.Email))
		}
	}
	queued := 0
	for _, a := range to {
		addr, locale, loc := "", mail.LocaleEN, b.series.Loc
		if a.UserID != nil {
			u, ok := users[*a.UserID]
			if !ok || u.Email == nil || u.EmailVerifiedAt == nil || u.IsBot || u.IsGuest {
				continue // no confirmed address: no mail
			}
			addr = *u.Email
			if u.Locale != nil {
				locale = *u.Locale
			}
			if u.Timezone != nil {
				loc = loadZone(*u.Timezone)
			}
		} else {
			addr = deref(a.Email)
			if org.Locale != nil {
				locale = *org.Locale
			}
		}
		date, when := formatWhen(locale, occ, b.ev.AllDay, loc)
		p := mail.Params{
			"title": b.ev.Title, "date": date, "when": when, "organizer": org.DisplayName, "url": s.eventURL(b.ev.ID),
			"room": roomName, "repeat": repeatText(locale, b.series.Rule.Repeat), "attendees": strings.Join(names, ", "),
			mail.ParamICS: ics, mail.ParamICSMethod: method,
		}
		if org.Email != nil {
			p[mail.ParamReplyTo] = *org.Email
		}
		if a.UserID == nil && method == MethodRequest {
			s.externalLinks(ctx, b, a, p)
		}
		err := s.mail.Enqueue(ctx, nil, mail.Mail{To: addr, Template: tmpl, Locale: locale, Params: p, Priority: mail.PriorityNotice, TTL: mailTTL})
		if err != nil {
			logErr(ctx, "mail: enqueue", err)
			continue
		}
		queued++
	}
	if queued > 0 {
		s.mail.Wake()
	}
}

// externalLinks adds the signed answer links and the guest link of an external attendee.
func (s *Service) externalLinks(ctx context.Context, b *bundle, a sqlc.EventAttendee, p mail.Params) {
	exp := s.tokenExpiry(b)
	base := s.eventURL(b.ev.ID) + "/rsvp?t="
	for param, st := range map[string]string{"rsvp_accept": StatusAccepted, "rsvp_decline": StatusDeclined, "rsvp_maybe": StatusMaybe} {
		p[param] = base + url.QueryEscape(signRSVP(s.key, rsvpClaims{Event: b.ev.ID, Status: st, Email: deref(a.Email), Exp: exp}))
	}
	if a.InviteID != nil {
		if inv, err := s.db.Q.GetRoomInvite(ctx, *a.InviteID); err == nil && inv.RevokedAt == nil {
			p["guest_url"] = strings.TrimRight(s.cfg.PublicURL, "/") + "/r/" + inv.Code
		}
	}
}

// tokenExpiry: answers are accepted until the meeting (the series) ends; an endless series
// takes a year from now.
func (s *Service) tokenExpiry(b *bundle) time.Time {
	if u := b.series.UntilAt(); u != nil {
		return *u
	}
	return s.Now().Add(365 * 24 * time.Hour)
}

func (s *Service) icsEvent(b *bundle, method string, users map[uuid.UUID]sqlc.ListEventUsersRow, org sqlc.ListEventUsersRow, roomName string) ICSEvent {
	e := ICSEvent{
		UID: b.ev.ID.String() + "@calab", Sequence: int(b.ev.Sequence), Method: method, Series: b.series,
		Title: b.ev.Title, Description: b.ev.Description, URL: s.eventURL(b.ev.ID), Stamp: s.Now(),
		Organizer: ICSPerson{Name: org.DisplayName, Email: s.organizerAddress(org)},
	}
	if roomName != "" {
		e.Location = "Calab: " + roomName
	}
	for _, a := range b.att {
		p := ICSPerson{Optional: !a.Required, PartStat: PartStat(a.Status)}
		if a.UserID != nil {
			u := users[*a.UserID]
			if u.Email == nil || u.EmailVerifiedAt == nil || u.IsBot || u.IsGuest {
				continue
			}
			p.Name, p.Email = u.DisplayName, *u.Email
		} else {
			p.Email = deref(a.Email)
		}
		e.Attendees = append(e.Attendees, p)
	}
	return e
}

// organizerAddress: the organizer's confirmed address, else the system sender (replies reach
// the organizer through Reply-To).
func (s *Service) organizerAddress(org sqlc.ListEventUsersRow) string {
	if org.Email != nil && org.EmailVerifiedAt != nil {
		return *org.Email
	}
	from := s.cfg.MailFrom
	if i := strings.LastIndexByte(from, '<'); i >= 0 {
		from = strings.TrimSuffix(from[i+1:], ">")
	}
	if from == "" {
		return "noreply@calab.invalid"
	}
	return from
}

// formatWhen renders an occurrence for a mail in loc: the date for the subject and the full
// time range with the zone.
func formatWhen(locale string, o Occurrence, allDay bool, loc *time.Location) (date, when string) {
	dateFmt := "2006-01-02"
	if locale == mail.LocaleRU {
		dateFmt = "02.01.2006"
	}
	st, en := o.Start.In(loc), o.End.In(loc)
	date = st.Format(dateFmt)
	if allDay {
		last := en.Add(-time.Second)
		if last.Format(dateFmt) == date {
			return date, date
		}
		return date, date + " – " + last.Format(dateFmt)
	}
	when = date + " " + st.Format("15:04") + "–"
	if en.Format(dateFmt) != date {
		when += en.Format(dateFmt) + " "
	}
	return date, when + en.Format("15:04") + " (" + loc.String() + ")"
}

var repeatTexts = map[string][5]string{
	mail.LocaleEN:   {"", "every day", "every week", "every two weeks", "every month"},
	mail.LocaleRU:   {"", "каждый день", "каждую неделю", "раз в две недели", "каждый месяц"},
	mail.LocaleES:   {"", "cada día", "cada semana", "cada dos semanas", "cada mes"},
	mail.LocaleZhCN: {"", "每天", "每周", "每两周", "每月"},
}

func repeatText(locale string, r v1.EventRepeat) string {
	t, ok := repeatTexts[mail.Locale(locale)]
	if !ok || int(r) < 0 || int(r) >= len(t) {
		return ""
	}
	return t[r]
}
