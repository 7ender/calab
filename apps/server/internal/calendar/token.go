package calendar

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"time"

	"github.com/google/uuid"
)

// RSVP tokens (ADR-0038 «Дополнение»): an external attendee answers from the invitation mail
// without an account. The token is the capability: base64url(event id ‖ status ‖ expiry ‖
// email ‖ HMAC-SHA256 truncated to 128 bits). A key of its own is derived from JWT_SECRET.
// Status `view` (the meeting link of the mail, «Диплинки для приглашённых») opens the page
// only: answers need an answer token.

var (
	errTokenInvalid = errors.New("calendar: rsvp token invalid")
	errTokenExpired = errors.New("calendar: rsvp token expired")
)

// statusView: the claim of a view token (not an attendee status).
const statusView = "view"

// statusCodes: one byte per answer (or view) in the token.
var statusCodes = map[string]byte{StatusAccepted: 1, StatusDeclined: 2, StatusMaybe: 3, statusView: 4}

type rsvpClaims struct {
	Event  uuid.UUID
	Status string
	Email  string
	Exp    time.Time
}

func tokenKey(secret []byte) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte("calab/event-rsvp/v1"))
	return m.Sum(nil)
}

const macLen = 16

func signRSVP(key []byte, c rsvpClaims) string {
	b := make([]byte, 0, 16+1+8+len(c.Email)+macLen)
	b = append(b, c.Event[:]...)
	b = append(b, statusCodes[c.Status])
	b = binary.BigEndian.AppendUint64(b, uint64(c.Exp.Unix())) //nolint:gosec // a time after 1970
	b = append(b, c.Email...)
	m := hmac.New(sha256.New, key)
	m.Write(b)
	return base64.RawURLEncoding.EncodeToString(m.Sum(b)[:len(b)+macLen])
}

// verifyRSVP checks the signature, then the expiry against now.
func verifyRSVP(key []byte, tok string, now time.Time) (rsvpClaims, error) {
	var c rsvpClaims
	raw, err := base64.RawURLEncoding.DecodeString(tok)
	if err != nil || len(raw) < 16+1+8+3+macLen || len(raw) > 16+1+8+254+macLen {
		return c, errTokenInvalid
	}
	body, sig := raw[:len(raw)-macLen], raw[len(raw)-macLen:]
	m := hmac.New(sha256.New, key)
	m.Write(body)
	if !hmac.Equal(m.Sum(nil)[:macLen], sig) {
		return c, errTokenInvalid
	}
	copy(c.Event[:], body[:16])
	for s, code := range statusCodes {
		if code == body[16] {
			c.Status = s
		}
	}
	if c.Status == "" {
		return c, errTokenInvalid
	}
	c.Exp = time.Unix(int64(binary.BigEndian.Uint64(body[17:25])), 0) //nolint:gosec // written by signRSVP
	c.Email = string(body[25:])
	if !now.Before(c.Exp) {
		return c, errTokenExpired
	}
	return c, nil
}
