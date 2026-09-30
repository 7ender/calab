package sip

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/voice"
)

// Final reasons (SipCall.reason).
const (
	reasonHangup      = "hangup"
	reasonModerator   = "hangup_moderator"
	reasonCancelled   = "cancelled"
	reasonRemote      = "remote"
	reasonEmpty       = "empty"
	reasonRoomClosed  = "room_closed"
	reasonLost        = "lost"
	reasonDisabled    = "disabled"
	reasonBusy        = "busy"
	reasonNoAnswer    = "no_answer"
	reasonDeclined    = "declined"
	reasonInvalid     = "invalid_number"
	reasonAuth        = "provider_auth"
	reasonUnavailable = "unavailable"
	reasonError       = "error"
)

// publish sends SIP_CALL_UPDATE to the viewers of the call's room (calls without a room — the
// connection tests — are not published).
func (s *Service) publish(ctx context.Context, c sqlc.SipCall) {
	if c.RoomID == nil {
		return
	}
	s.events.Workspace(ctx, c.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_SipCallUpdate{SipCallUpdate: &v1.SipCallUpdate{Call: pbconv.SipCall(c)}}})
}

// inCall reports whether the user has a device in the room's call (joined or joining).
func (s *Service) inCall(ctx context.Context, wid, rid, user uuid.UUID) (bool, error) {
	states, err := s.voice.List(ctx, wid)
	if err != nil {
		return false, err
	}
	for _, st := range states {
		if st.UserID == user && st.RoomID == rid && !st.Pending {
			return true, nil
		}
	}
	return false, nil
}

// occupied reports whether anyone (a person or a bot) is in the room's call.
func (s *Service) occupied(ctx context.Context, wid, rid uuid.UUID) (bool, error) {
	states, err := s.voice.List(ctx, wid)
	if err != nil {
		return false, err
	}
	for _, st := range states {
		if st.RoomID == rid {
			return true, nil
		}
	}
	return false, nil
}

// callRoom resolves the room of a call route: a voice room of a workspace the caller may view.
func callRoom(r *http.Request) (sqlc.Room, perm.RoomAccess, error) {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return sqlc.Room{}, perm.RoomAccess{}, err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return sqlc.Room{}, acc, err
	}
	if acc.DM || acc.Task {
		return sqlc.Room{}, acc, httpx.NotFound("room")
	}
	if acc.Role == perm.RoleGuest {
		return sqlc.Room{}, acc, httpx.Forbidden("guests cannot place phone calls")
	}
	return sqlc.Room{ID: roomID}, acc, nil
}

func (s *Service) place(w http.ResponseWriter, r *http.Request) error {
	room, acc, err := callRoom(r)
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.ViewRoom | perm.Connect | perm.PlaceCalls) {
		return httpx.Forbidden("PLACE_CALLS required")
	}
	ctx, me := r.Context(), uid(r)
	if room, err = s.db.Q.GetRoom(ctx, room.ID); db.IsNotFound(err) {
		return httpx.NotFound("room")
	} else if err != nil {
		return err
	}
	if room.Type != "voice" {
		return httpx.Validation("id", "phone calls are placed from voice rooms")
	}
	var req v1.PlaceSipCallRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	number, ok := NormalizeNumber(req.GetNumber())
	if !ok {
		return httpx.Validation("number", "not a phone number: use the international format, e.g. +7 916 123-45-67")
	}
	a, _, err := s.account(ctx, s.db.Q, acc.WorkspaceID)
	if err != nil {
		return err
	}
	if !a.Enabled || a.TrunkID == "" || s.sip == nil || s.lk == nil {
		return errDisabled
	}
	if !Allowed(number, a.AllowedPrefixes) {
		return numberNotAllowed()
	}
	if in, err := s.inCall(ctx, acc.WorkspaceID, room.ID, me); err != nil {
		return httpx.Unavailable(err)
	} else if !in {
		return errNotInVC
	}
	if _, err := s.db.Q.GetLiveSipCallByRoom(ctx, &room.ID); err == nil {
		return errActive
	} else if !db.IsNotFound(err) {
		return err
	}
	if err := s.CallLimit.Take(ctx, acc.WorkspaceID.String()); err != nil {
		if e := httpx.AsError(err); e.Code == v1.ErrorCode_ERROR_CODE_RATE_LIMITED {
			sipErr := httpx.Coded(http.StatusTooManyRequests, v1.ErrorCode_ERROR_CODE_SIP_RATE_LIMITED, "too many phone calls from this workspace; try again later")
			sipErr.RetryAfter = e.RetryAfter
			return sipErr
		}
		return err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	call, err := s.db.Q.InsertSipCall(ctx, sqlc.InsertSipCallParams{
		ID: id, WorkspaceID: acc.WorkspaceID, RoomID: &room.ID, Number: number, StartedBy: &me,
		ParticipantIdentity: rtc.SIPIdentity(id),
	})
	if db.UniqueViolation(err) != "" {
		return errActive // a concurrent call won the room
	}
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: call placed", "workspace", acc.WorkspaceID, "room", room.ID, "call", id, "by", me)
	s.publish(ctx, call)
	go s.dial(call, a, voice.RoomName(acc.WorkspaceID, room.ID))
	httpx.Write(w, http.StatusCreated, &v1.SipCallResponse{Call: pbconv.SipCall(call)})
	return nil
}

// dial asks LiveKit to call and waits for the answer (CreateSIPParticipant with
// wait_until_answered), then records ACTIVE or FAILED. A call ended meanwhile (hangup,
// everybody left) has its line removed again.
func (s *Service) dial(call sqlc.SipCall, a sqlc.SipAccount, lkRoom string) {
	ctx, cancel := context.WithTimeout(context.Background(), s.opts.RingingTimeout+45*time.Second)
	defer cancel()
	info, err := s.sip.CreateSIPParticipant(ctx, rtc.SIPCall{
		TrunkID: a.TrunkID, CallTo: DialString(a.OutboundPrefix, call.Number), Room: lkRoom,
		Identity: call.ParticipantIdentity, Name: call.Number,
		Attributes:        map[string]string{"calab.callId": call.ID.String()},
		WaitUntilAnswered: true, RingingTimeout: s.opts.RingingTimeout, MaxCallDuration: s.opts.MaxCallTime,
	})
	ctx = context.WithoutCancel(ctx)
	if err == nil {
		row, err := s.db.Q.MarkSipCallActive(ctx, sqlc.MarkSipCallActiveParams{ID: call.ID, SipCallID: info.SIPCallID})
		switch {
		case err == nil:
			s.publish(ctx, row)
		case db.IsNotFound(err): // ended while ringing: take the line out
			s.removeLine(ctx, lkRoom, call.ParticipantIdentity)
		default:
			slog.WarnContext(ctx, "sip: mark call active", "call", call.ID, "err", err)
		}
		return
	}
	reason := failureReason(err)
	slog.InfoContext(ctx, "sip: call failed", "call", call.ID, "reason", reason, "err", err)
	s.finish(ctx, call.ID, pbconv.SipFailed, reason, nil)
	s.removeLine(ctx, lkRoom, call.ParticipantIdentity)
}

// failureReason maps a CreateSIPParticipant error to SipCall.reason.
func failureReason(err error) string {
	code, _ := rtc.SIPStatus(err)
	switch code {
	case 486, 600:
		return reasonBusy
	case 408, 480, 487:
		return reasonNoAnswer
	case 603, 607, 608:
		return reasonDeclined
	case 404, 410, 484, 485, 604:
		return reasonInvalid
	case 401, 403, 407:
		return reasonAuth
	case 0:
	default:
		return fmt.Sprintf("%s %d", reasonError, code)
	}
	var e *rtc.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return reasonNoAnswer
	case errors.As(err, &e) && e.Code == "deadline_exceeded":
		return reasonNoAnswer
	case errors.As(err, &e) && e.Code != "unavailable" && e.Code != "internal":
		return reasonError
	}
	return reasonUnavailable
}

// finish ends a live call once and publishes it; a call already final is left alone.
func (s *Service) finish(ctx context.Context, id uuid.UUID, status, reason string, by *uuid.UUID) (sqlc.SipCall, bool) {
	row, err := s.db.Q.FinishSipCall(ctx, sqlc.FinishSipCallParams{ID: id, Status: status, Reason: reason, EndedBy: by})
	if err != nil {
		if !db.IsNotFound(err) {
			slog.WarnContext(ctx, "sip: finish call", "call", id, "err", err)
		}
		return row, false
	}
	s.publish(ctx, row)
	return row, true
}

// removeLine takes a phone line out of its LiveKit room (hangs up); a line already gone is fine.
func (s *Service) removeLine(ctx context.Context, lkRoom, identity string) {
	if s.lk == nil {
		return
	}
	if err := s.lk.RemoveParticipant(ctx, lkRoom, identity); err != nil && !rtc.IsNotFound(err) {
		slog.WarnContext(ctx, "sip: remove phone line", "identity", identity, "err", err)
	}
}

func (s *Service) hangup(w http.ResponseWriter, r *http.Request) error {
	room, acc, err := callRoom(r)
	if err != nil {
		return err
	}
	cid, err := httpx.PathUUID(r, "cid", "call")
	if err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	call, err := s.db.Q.GetSipCall(ctx, cid)
	if db.IsNotFound(err) || (err == nil && (call.RoomID == nil || *call.RoomID != room.ID)) {
		return httpx.NotFound("call")
	}
	if err != nil {
		return err
	}
	mine := call.StartedBy != nil && *call.StartedBy == me
	if !mine && !acc.Bits.Has(perm.MuteMembers) {
		return httpx.Forbidden("only the caller or MUTE_MEMBERS may end this call")
	}
	if !pbconv.SipCallLive(call.Status) {
		return httpx.Conflict("the call is over")
	}
	lkRoom := voice.RoomName(acc.WorkspaceID, room.ID)
	if s.lk != nil {
		if err := s.lk.RemoveParticipant(ctx, lkRoom, call.ParticipantIdentity); err != nil && !rtc.IsNotFound(err) {
			return httpx.Unavailable(err)
		}
	}
	reason := reasonHangup
	switch {
	case call.Status != pbconv.SipActive:
		reason = reasonCancelled
	case !mine:
		reason = reasonModerator
	}
	row, ok := s.finish(ctx, cid, pbconv.SipEnded, reason, &me)
	if !ok {
		if row, err = s.db.Q.GetSipCall(ctx, cid); err != nil {
			return err
		}
		if pbconv.SipCallLive(row.Status) {
			return httpx.Conflict("the call changed meanwhile")
		}
	}
	slog.InfoContext(ctx, "sip: call ended", "call", cid, "by", me, "reason", row.Reason)
	httpx.Write(w, http.StatusOK, &v1.SipCallResponse{Call: pbconv.SipCall(row)})
	return nil
}

// hangupWorkspace ends every live call of a workspace (telephony switched off).
func (s *Service) hangupWorkspace(ctx context.Context, wsID uuid.UUID) {
	ctx = context.WithoutCancel(ctx)
	live, err := s.db.Q.ListLiveSipCallsByWorkspace(ctx, wsID)
	if err != nil {
		slog.WarnContext(ctx, "sip: list live calls", "workspace", wsID, "err", err)
		return
	}
	for _, c := range live {
		s.removeLine(ctx, voice.RoomName(wsID, *c.RoomID), c.ParticipantIdentity)
		s.finish(ctx, c.ID, pbconv.SipEnded, reasonDisabled, nil)
	}
}

func (s *Service) journal(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manage(r)
	if err != nil {
		return err
	}
	p := sqlc.ListSipCallsParams{WorkspaceID: wsID, Lim: journalPage + 1}
	qv := r.URL.Query()
	for _, f := range []struct {
		name string
		dst  **time.Time
	}{{"from", &p.From}, {"to", &p.To}} {
		if v := qv.Get(f.name); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				return httpx.Validation(f.name, f.name+" must be an RFC 3339 time")
			}
			*f.dst = &t
		}
	}
	if v := qv.Get("cursor"); v != "" {
		c, err := uuid.Parse(v)
		if err != nil {
			return httpx.Validation("cursor", "bad cursor")
		}
		p.Cursor = &c
	}
	rows, err := s.db.Q.ListSipCalls(r.Context(), p)
	if err != nil {
		return err
	}
	out := &v1.ListSipCallsResponse{Calls: make([]*v1.SipCall, 0, min(len(rows), journalPage))}
	for i, c := range rows {
		if i == journalPage {
			out.NextCursor = rows[i-1].ID.String()
			break
		}
		out.Calls = append(out.Calls, pbconv.SipCall(c))
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// ---- connection test ----

// testOK: SIP answers that prove the provider took our credentials and routed the call.
var testOK = map[int]bool{486: true, 600: true, 480: true, 408: true, 487: true, 603: true, 607: true, 608: true}

func (s *Service) test(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manage(r)
	if err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	a, _, err := s.account(ctx, s.db.Q, wsID)
	if err != nil {
		return err
	}
	if !a.Enabled || a.TrunkID == "" || s.sip == nil || s.lk == nil {
		return errDisabled
	}
	if err := s.TestLimit.Take(ctx, wsID.String()); err != nil {
		if e := httpx.AsError(err); e.Code == v1.ErrorCode_ERROR_CODE_RATE_LIMITED {
			sipErr := httpx.Coded(http.StatusTooManyRequests, v1.ErrorCode_ERROR_CODE_SIP_RATE_LIMITED, "too many connection tests; try again later")
			sipErr.RetryAfter = e.RetryAfter
			return sipErr
		}
		return err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	// A service room outside Calaba's naming (webhooks ignore it), closed right after.
	lkRoom := "sip-test_" + id.String()
	if err := s.lk.CreateRoom(ctx, lkRoom, 30, 2); err != nil {
		return httpx.Unavailable(err)
	}
	defer func() {
		if err := s.lk.DeleteRoom(context.WithoutCancel(ctx), lkRoom); err != nil && !rtc.IsNotFound(err) {
			slog.WarnContext(ctx, "sip: delete test room", "room", lkRoom, "err", err)
		}
	}()
	call, err := s.db.Q.InsertSipCall(ctx, sqlc.InsertSipCallParams{
		ID: id, WorkspaceID: wsID, Number: a.CallerID, StartedBy: &me, ParticipantIdentity: rtc.SIPIdentity(id),
	})
	if err != nil {
		return err
	}
	tctx, cancel := context.WithTimeout(ctx, testRinging+10*time.Second)
	defer cancel()
	_, err = s.sip.CreateSIPParticipant(tctx, rtc.SIPCall{
		TrunkID: a.TrunkID, CallTo: DialString(a.OutboundPrefix, a.CallerID), Room: lkRoom,
		Identity: call.ParticipantIdentity, Name: "connection test", WaitUntilAnswered: true,
		RingingTimeout: testRinging, MaxCallDuration: testMaxCall,
	})
	bg := context.WithoutCancel(ctx)
	out := &v1.TestSipResponse{}
	if err == nil {
		out.Ok, out.Message = true, "answered"
		s.removeLine(bg, lkRoom, call.ParticipantIdentity)
		s.finish(bg, id, pbconv.SipEnded, reasonHangup, &me)
	} else {
		code, text := rtc.SIPStatus(err)
		out.SipStatus = uint32(max(code, 0)) //nolint:gosec // SIP codes are 3 digits
		out.Ok = testOK[code]
		switch {
		case code > 0:
			out.Message = fmt.Sprintf("%d %s", code, text)
		case errors.Is(err, context.DeadlineExceeded):
			out.Ok, out.Message = true, "no answer"
		default:
			var e *rtc.Error
			if errors.As(err, &e) && e.Msg != "" {
				out.Message = clip(e.Msg, 300)
			} else {
				out.Message = "LiveKit SIP is unreachable"
			}
		}
		s.finish(bg, id, pbconv.SipFailed, failureReason(err), nil)
	}
	last := ""
	if !out.Ok {
		last = out.Message
	}
	if err := s.db.Q.SetSipLastError(bg, sqlc.SetSipLastErrorParams{WorkspaceID: wsID, LastError: last}); err != nil {
		slog.WarnContext(ctx, "sip: store last_error", "workspace", wsID, "err", err)
	}
	slog.InfoContext(ctx, "sip: connection test", "workspace", wsID, "by", me, "ok", out.Ok, "message", out.Message)
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// ---- LiveKit webhooks (rtc.SIPHook) ----

var _ rtc.SIPHook = (*Service)(nil)

// SIPParticipant applies a phone line's participant_joined / _left.
func (s *Service) SIPParticipant(ctx context.Context, event string, wid, rid uuid.UUID, p *rtc.Participant) error {
	id, ok := rtc.ParseSIPIdentity(p.Identity)
	if !ok {
		return nil
	}
	call, err := s.db.Q.GetSipCall(ctx, id)
	if db.IsNotFound(err) || (err == nil && (call.RoomID == nil || *call.RoomID != rid || call.WorkspaceID != wid)) {
		return nil // not a call of this room
	}
	if err != nil {
		return err
	}
	lkRoom := voice.RoomName(wid, rid)
	switch event {
	case rtc.EventParticipantJoined:
		if !pbconv.SipCallLive(call.Status) {
			s.removeLine(ctx, lkRoom, p.Identity) // hung up before the line got in
			return nil
		}
		var row sqlc.SipCall
		switch p.Attributes[rtc.AttrSIPCallStatus] {
		case "active":
			row, err = s.db.Q.MarkSipCallActive(ctx, sqlc.MarkSipCallActiveParams{ID: id, SipCallID: p.Attributes[rtc.AttrSIPCallID]})
		case "ringing":
			row, err = s.db.Q.MarkSipCallRinging(ctx, id)
		default:
			return nil
		}
		if db.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		s.publish(ctx, row)
	case rtc.EventParticipantLeft, rtc.EventParticipantAborted:
		// Before the answer the dialing request reports the outcome (busy, no answer…); the
		// sweeper covers a lost one.
		if call.Status == pbconv.SipActive {
			s.finish(ctx, id, pbconv.SipEnded, reasonRemote, nil)
		}
	}
	return nil
}

// PersonLeft hangs up the room's phone call when nobody is left in the room's call.
func (s *Service) PersonLeft(ctx context.Context, wid, rid uuid.UUID) {
	call, err := s.db.Q.GetLiveSipCallByRoom(ctx, &rid)
	if err != nil {
		if !db.IsNotFound(err) {
			slog.WarnContext(ctx, "sip: live call of a room", "room", rid, "err", err)
		}
		return
	}
	if busy, err := s.occupied(ctx, wid, rid); err != nil || busy {
		return
	}
	s.removeLine(ctx, voice.RoomName(wid, rid), call.ParticipantIdentity)
	s.finish(ctx, call.ID, pbconv.SipEnded, reasonEmpty, nil)
}

// SIPRoomFinished ends the room's call: LiveKit closed the room, the line is gone with it.
func (s *Service) SIPRoomFinished(ctx context.Context, rid uuid.UUID) {
	call, err := s.db.Q.GetLiveSipCallByRoom(ctx, &rid)
	if err != nil {
		return
	}
	s.finish(ctx, call.ID, pbconv.SipEnded, reasonRoomClosed, nil)
}

// ---- sweeper ----

// Run sweeps lost calls until ctx is done.
func (s *Service) Run(ctx context.Context) {
	t := time.NewTicker(s.opts.SweepInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Sweep(ctx)
		}
	}
}

// Sweep ends calls whose end no event reported (one instance per period, Redis lock):
// dialing / ringing past the ringing timeout, active lines gone from LiveKit or left alone in
// the room, calls of deleted rooms and interrupted connection tests.
func (s *Service) Sweep(ctx context.Context) {
	lock := s.redis.B().Set().Key(redisx.Key("sip:sweep")).Value("1").Nx().Ex(s.opts.SweepInterval - time.Second/2).Build()
	if err := s.redis.Do(ctx, lock).Error(); err != nil {
		return // another instance sweeps (or Redis is down)
	}
	now := time.Now()
	live, err := s.db.Q.ListLiveSipCalls(ctx, now.Add(-30*time.Second))
	if err != nil {
		slog.WarnContext(ctx, "sip: sweep", "err", err)
		return
	}
	ringDeadline := now.Add(-(s.opts.RingingTimeout + 90*time.Second))
	for _, c := range live {
		if c.RoomID == nil { // a deleted room or an interrupted connection test
			s.finish(ctx, c.ID, pbconv.SipEnded, reasonLost, nil)
			continue
		}
		lkRoom := voice.RoomName(c.WorkspaceID, *c.RoomID)
		if c.Status != pbconv.SipActive {
			if c.StartedAt.Before(ringDeadline) {
				s.removeLine(ctx, lkRoom, c.ParticipantIdentity)
				s.finish(ctx, c.ID, pbconv.SipFailed, reasonLost, nil)
			}
			continue
		}
		if s.lk == nil {
			continue
		}
		if _, err := s.lk.GetParticipant(ctx, lkRoom, c.ParticipantIdentity); rtc.IsNotFound(err) {
			s.finish(ctx, c.ID, pbconv.SipEnded, reasonLost, nil)
			continue
		} else if err != nil {
			continue
		}
		if busy, err := s.occupied(ctx, c.WorkspaceID, *c.RoomID); err == nil && !busy {
			s.removeLine(ctx, lkRoom, c.ParticipantIdentity)
			s.finish(ctx, c.ID, pbconv.SipEnded, reasonEmpty, nil)
		}
	}
}
