package rtc

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/calaba/calaba/server/internal/voice"
)

// moveMember: POST /api/rooms/{id}/voice/{userId}/move {targetRoomId}. The actor needs
// MOVE_MEMBERS in both rooms; the moved user needs VIEW_ROOM + CONNECT in the target; the
// target's user_limit applies unless the actor is an administrator. Every device of the
// user in the source room is moved with LiveKit MoveParticipant (no reconnect).
func (s *Service) moveMember(w http.ResponseWriter, r *http.Request) error {
	srcID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, srcID)
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.MoveMembers) {
		return httpx.Forbidden("MOVE_MEMBERS required")
	}
	target, err := httpx.PathUUID(r, "userId", "member")
	if err != nil {
		return err
	}
	if err := outranks(r, acc.WorkspaceID, target); err != nil {
		return err
	}
	var req v1.MoveMemberRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	dstID, err := uuid.Parse(req.GetTargetRoomId())
	if err != nil || dstID == srcID {
		return httpx.Validation("targetRoomId", "target must be another voice room")
	}
	dst, _, err := s.roomInfo(r.Context(), dstID)
	if db.IsNotFound(err) || (err == nil && (dst.WorkspaceID != acc.WorkspaceID || dst.Type != "voice")) {
		return httpx.Validation("targetRoomId", "target must be a voice room of the same workspace")
	}
	if err != nil {
		return err
	}
	actor := auth.MustFromContext(r.Context()).UserID
	res := perm.FromContext(r.Context())
	actorDst, err := res.Room(r.Context(), dstID, actor)
	if err != nil && !errors.Is(err, perm.ErrNoRoom) {
		return err
	}
	if !actorDst.Bits.Has(perm.ViewRoom | perm.MoveMembers) {
		return httpx.Forbidden("MOVE_MEMBERS required in the target room")
	}
	movedDst, err := res.Room(r.Context(), dstID, target)
	if err != nil && !errors.Is(err, perm.ErrNoRoom) {
		return err
	}
	if !movedDst.Bits.Has(perm.ViewRoom | perm.Connect) {
		return httpx.Forbidden("the member cannot connect to the target room")
	}
	if dst.UserLimit > 0 && !actorDst.Bits.Has(perm.Administrator) {
		full, err := s.roomFull(r.Context(), dst.WorkspaceID, dstID, int(dst.UserLimit), target)
		if err != nil {
			return err
		}
		if full {
			return errRoomFull
		}
	}
	sess, err := s.memberSessions(r.Context(), acc.WorkspaceID, srcID, target)
	if err != nil {
		return err
	}
	if len(sess) == 0 {
		return httpx.NotFound("member in this voice room")
	}
	srcName, dstName := voice.RoomName(acc.WorkspaceID, srcID), voice.RoomName(acc.WorkspaceID, dstID)
	if err := s.lk.CreateRoom(r.Context(), dstName, EmptyTimeout, s.cfg.MaxParticipants); err != nil {
		return httpx.Unavailable(err)
	}
	streams, err := s.voice.Streams(r.Context(), srcID)
	if err != nil {
		return err
	}
	moved := 0
	for _, st := range sess {
		identity := voice.Identity(st.UserID, st.SessionID)
		prev := st
		// Record the device in the target first: LiveKit may deliver participant_joined for
		// the target before we get here again, and the join revalidation must then see the
		// user as already inside (an admin may move into a full room — review R3).
		c, err := s.voice.Update(r.Context(), acc.WorkspaceID, target, st.SessionID, func(cur *voice.SessionState) *voice.SessionState {
			if cur == nil || cur.RoomID != srcID {
				return cur
			}
			n := *cur
			n.RoomID, n.JoinedAt = dstID, time.Now().UnixMilli()
			return &n
		})
		if err != nil {
			return err
		}
		if err := s.lk.MoveParticipant(r.Context(), srcName, identity, dstName); err != nil {
			// Roll back to the source room.
			_, _ = s.voice.Update(r.Context(), acc.WorkspaceID, target, st.SessionID, func(cur *voice.SessionState) *voice.SessionState {
				if cur == nil || cur.RoomID != dstID {
					return cur
				}
				n := prev
				return &n
			})
			if IsNotFound(err) {
				continue // device already left; webhook / reconcile clean up
			}
			return httpx.Unavailable(err)
		}
		moved++
		s.publishVoice(r.Context(), acc.WorkspaceID, c)
		if err := s.lk.UpdatePermission(r.Context(), dstName, identity, Grant(movedDst.Bits, st.Streaming)); err != nil && !IsNotFound(err) {
			return httpx.Unavailable(err)
		}
		// Tracks move with the participant: carry the stream records over.
		for sid, rec := range streams {
			if rec.Identity != identity {
				continue
			}
			if ok, _ := s.voice.RemoveStream(r.Context(), srcID, sid); ok {
				s.publishStreamStop(r.Context(), acc.WorkspaceID, srcID, target, sid, v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_ENDED)
			}
			if ok, err := s.voice.AddStream(r.Context(), dstID, sid, rec, -1); err == nil && ok {
				s.events.Workspace(r.Context(), acc.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceStreamStart{VoiceStreamStart: &v1.VoiceStreamStart{
					WorkspaceId: acc.WorkspaceID.String(), RoomId: dstID.String(), UserId: target.String(), TrackSid: sid, Preset: rec.Preset,
				}}})
			}
		}
	}
	if moved == 0 {
		return httpx.NotFound("member in this voice room")
	}
	s.events.User(r.Context(), target, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceMoved{VoiceMoved: &v1.VoiceMoved{
		WorkspaceId: acc.WorkspaceID.String(), FromRoomId: srcID.String(), ToRoomId: dstID.String(), ByUserId: actor.String(),
	}}})
	httpx.NoContent(w)
	return nil
}
