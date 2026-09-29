package calendar

import (
	"context"
	"crypto/rand"
	"errors"
	"math/big"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/perm"
)

// Meeting guest links (ADR-0038 «Дополнение», ADR-0016): each external attendee of a meeting
// with a room gets a single-use room link, valid from 15 minutes before the next occurrence
// until 1 h after it (a series: until 90 days after it), made on behalf of the organizer.

// guestBits: what a meeting guest may do in the room (as a default room link: speak and write).
const guestBits = perm.ViewRoom | perm.Connect | perm.Speak | perm.SendMessages

// Same alphabet and length as the room links of internal/guests (the code is the capability).
const (
	codeAlphabet = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"
	codeLen      = 12
)

func newCode() (string, error) {
	b := make([]byte, codeLen)
	n := big.NewInt(int64(len(codeAlphabet)))
	for i := range b {
		k, err := rand.Int(rand.Reader, n)
		if err != nil {
			return "", err
		}
		b[i] = codeAlphabet[k.Int64()]
	}
	return string(b), nil
}

// linkWindow is the validity of a meeting's guest link at now; false = no occurrence ahead.
func linkWindow(s Series, now time.Time) (notBefore, expires time.Time, ok bool) {
	occ, ok := s.Next(now, lookAhead)
	if !ok {
		return time.Time{}, time.Time{}, false
	}
	expires = occ.End.Add(guestLinkAfter)
	if s.Rule.Repeat != 0 {
		expires = occ.End.Add(seriesLinkSpan)
		if u := s.UntilAt(); u != nil && u.Before(expires) {
			expires = u.Add(guestLinkAfter)
		}
	}
	return occ.Start.Add(-guestLinkBefore), expires, true
}

// linkBits: the bits a guest link of the organizer grants in the room, 0 = the organizer may
// not make one (no MANAGE_ROOM there, or the workspace is suspended). Not wider than the
// organizer's own bits (no escalation through links), unless they are an administrator.
func linkBits(ctx context.Context, q *sqlc.Queries, b *bundle) (perm.Bits, error) {
	if b.ev.RoomID == nil {
		return 0, nil
	}
	if err := moderation.CheckSuspended(ctx, q, b.ev.WorkspaceID); err != nil {
		return 0, nil //nolint:nilerr // a suspended workspace takes no guests: no links
	}
	acc, err := perm.NewResolver(q).Room(ctx, *b.ev.RoomID, b.ev.OrganizerID)
	if errors.Is(err, perm.ErrNoRoom) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if !acc.Bits.Has(perm.ManageRoom) {
		return 0, nil
	}
	bits := guestBits
	if !acc.Bits.Has(perm.Administrator) {
		bits &= acc.Bits
	}
	if !bits.Has(perm.ViewRoom | perm.Connect) {
		return 0, nil
	}
	return bits, nil
}

// syncLinks brings the guest links of b's external attendees in line with the meeting (inside
// the transaction): with another room (or none) the old links are revoked; every external
// attendee without a link gets one; with new times the unused links move to the new window.
func (s *Service) syncLinks(ctx context.Context, q *sqlc.Queries, b *bundle, roomChanged, timeChanged bool) error {
	if roomChanged || b.ev.RoomID == nil {
		if err := q.RevokeEventRoomInvites(ctx, sqlc.RevokeEventRoomInvitesParams{EventID: &b.ev.ID}); err != nil {
			return err
		}
		for i, a := range b.att {
			if a.Email != nil && a.InviteID != nil {
				if err := q.SetEventAttendeeInvite(ctx, sqlc.SetEventAttendeeInviteParams{EventID: b.ev.ID, Email: a.Email}); err != nil {
					return err
				}
				b.att[i].InviteID = nil
			}
		}
	}
	if b.ev.RoomID == nil {
		return nil
	}
	var externals []int
	for i, a := range b.att {
		if a.Email != nil {
			externals = append(externals, i)
		}
	}
	if len(externals) == 0 {
		return nil
	}
	nb, exp, ok := linkWindow(b.series, s.Now())
	if !ok {
		return nil
	}
	bits, err := linkBits(ctx, q, b)
	if err != nil || bits == 0 {
		return err
	}
	for _, i := range externals {
		a := b.att[i]
		if a.InviteID != nil {
			if timeChanged {
				if err := q.MoveEventRoomInvite(ctx, sqlc.MoveEventRoomInviteParams{ID: *a.InviteID, NotBefore: &nb, ExpiresAt: &exp}); err != nil {
					return err
				}
			}
			continue
		}
		inv, err := s.createLink(ctx, q, b, bits, nb, exp)
		if err != nil {
			return err
		}
		if err := q.SetEventAttendeeInvite(ctx, sqlc.SetEventAttendeeInviteParams{EventID: b.ev.ID, Email: a.Email, InviteID: &inv.ID}); err != nil {
			return err
		}
		b.att[i].InviteID = &inv.ID
	}
	return nil
}

func (s *Service) createLink(ctx context.Context, q *sqlc.Queries, b *bundle, bits perm.Bits, nb, exp time.Time) (sqlc.RoomInvite, error) {
	for range 3 {
		code, err := newCode()
		if err != nil {
			return sqlc.RoomInvite{}, err
		}
		inv, err := q.CreateEventRoomInvite(ctx, sqlc.CreateEventRoomInviteParams{
			RoomID: *b.ev.RoomID, Code: code, CreatedBy: b.ev.OrganizerID, ExpiresAt: &exp,
			AllowBits: int64(bits), //nolint:gosec // bit mask
			NotBefore: &nb, EventID: &b.ev.ID,
		})
		if db.UniqueViolation(err) != "" {
			continue
		}
		return inv, err
	}
	return sqlc.RoomInvite{}, errors.New("calendar: invite code collisions")
}

// revokeLinks revokes the links of removed external attendees.
func revokeLinks(ctx context.Context, q *sqlc.Queries, eventID uuid.UUID, removed []sqlc.EventAttendee) error {
	var ids []uuid.UUID
	for _, a := range removed {
		if a.InviteID != nil {
			ids = append(ids, *a.InviteID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	return q.RevokeEventRoomInvites(ctx, sqlc.RevokeEventRoomInvitesParams{EventID: &eventID, Ids: ids})
}
