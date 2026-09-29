package rtc

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/calaba/calaba/server/internal/voice"
)

// Webcams (docs/05 "Камеры") follow the screen-share model:
//   - the join token has no camera source; POST /camera/request reserves it for the device
//     (VIDEO, in the call, a free slot under camera_limit) and pushes the grant;
//   - the limit is enforced atomically when the track is published (AddCamera, Lua): an
//     extra camera is muted, loses the grant and VOICE_CAMERA_STOP{LIMIT_REACHED} is sent;
//   - the camera source stays in the grant while the device has a reservation or a
//     recorded webcam (cameraHeld), so later grant pushes (resync, moves, stream changes)
//     keep it; stopping a camera (own or by a moderator) releases both;
//   - a moderator's stop is sticky (voice:camoff:<identity>) until the device leaves the
//     call or a moderator calls allow-camera: /camera/request answers 403 meanwhile;
//   - a move into a room without VIDEO for the member or with camera_limit 0 stops the
//     camera with VOICE_CAMERA_STOP{ROOM_POLICY}.

// cameraGrace spares young camera records in reconcile: a camera published and recorded
// between the participant listing and the reading of the records is not "gone" (L2).
const cameraGrace = 15 * time.Second

// cameraHeld reports whether the device keeps the camera source in its grant. Errors
// count as "no" (fail closed: no camera rather than a camera over the limit).
func (s *Service) cameraHeld(ctx context.Context, lkRoom, identity string) bool {
	_, rid, ok := voice.ParseRoomName(lkRoom)
	if !ok {
		return false
	}
	held, err := s.voice.CameraHeld(ctx, rid, identity)
	if err != nil {
		slog.WarnContext(ctx, "read camera reservation", "identity", identity, "err", err)
		return false
	}
	return held
}

// streamHeld reports whether the device keeps the screen-share source (a recorded stream
// or a pending /stream/request), so camera changes do not withdraw it.
func (s *Service) streamHeld(ctx context.Context, rid uuid.UUID, identity string) bool {
	if s.voice.ReservedStream(ctx, identity) != v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED {
		return true
	}
	streams, err := s.voice.Streams(ctx, rid)
	if err != nil {
		return false
	}
	for _, st := range streams {
		if st.Identity == identity {
			return true
		}
	}
	return false
}

// cameraSlotFree reports whether another webcam fits under the limit (the device's own
// cameras do not count against it).
func (s *Service) cameraSlotFree(ctx context.Context, rid uuid.UUID, identity string, limit uint32) (bool, error) {
	cams, err := s.voice.Cameras(ctx, rid)
	if err != nil {
		return false, err
	}
	n := uint32(0)
	for _, c := range cams {
		if c.Identity == identity {
			return true, nil
		}
		n++
	}
	return n < limit, nil
}

// requestCamera: POST /api/rooms/{id}/camera/request {preset?, fps?} → 200 with the granted
// quality (capped by the plan, ADR-0024) | 409 (limit reached, cameras off, not in the call).
func (s *Service) requestCamera(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return err
	}
	if acc.Notes { // a notes shelf has no voice (ADR-0039)
		return httpx.NotFound("room")
	}
	if acc.DM {
		return s.requestDMMedia(w, r, roomID, false)
	}
	if !acc.Bits.Has(perm.Connect | perm.Video) {
		return httpx.Forbidden("VIDEO required")
	}
	var req v1.RequestCameraRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	room, media, err := s.roomInfo(r.Context(), roomID)
	if err != nil {
		return err
	}
	if room.Type != "voice" {
		return httpx.Validation("id", "not a voice room")
	}
	if media.GetCameraLimit() == 0 {
		return httpx.Conflict("cameras are off in this room")
	}
	id := auth.MustFromContext(r.Context())
	identity := voice.Identity(id.UserID, id.SessionID)
	name := voice.RoomName(room.WorkspaceID, room.ID)
	if blocked, err := s.voice.CameraBlocked(r.Context(), identity); err != nil {
		return err
	} else if blocked {
		return httpx.Forbidden("camera stopped by a moderator until you leave the call or a moderator allows it")
	}
	if _, err := s.lk.GetParticipant(r.Context(), name, identity); err != nil {
		if IsNotFound(err) {
			return httpx.Conflict("join the voice room first")
		}
		return httpx.Unavailable(err)
	}
	free, err := s.cameraSlotFree(r.Context(), roomID, identity, media.GetCameraLimit())
	if err != nil {
		return err
	}
	if !free {
		return httpx.Conflict("camera limit of the room is reached")
	}
	if err := s.voice.ReserveCamera(r.Context(), identity); err != nil {
		return err
	}
	if err := s.pushGrant(r.Context(), name, identity, room.WorkspaceID, id.UserID, acc.Bits, s.streamHeld(r.Context(), roomID, identity)); err != nil {
		return httpx.Unavailable(err)
	}
	preset, fps := room.Plan.Camera(req.GetPreset(), req.GetFps())
	httpx.Write(w, http.StatusOK, &v1.RequestCameraResponse{Preset: preset, Fps: fps})
	return nil
}

// stopOwnCamera: POST /api/rooms/{id}/camera/stop → 204. Releases the device's camera:
// records, reservation and the grant (the client unpublishes the track itself).
func (s *Service) stopOwnCamera(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return err
	}
	id := auth.MustFromContext(r.Context())
	identity := voice.Identity(id.UserID, id.SessionID)
	if acc.DM { // a call keeps the camera source; only the records and the flag go
		s.dropCameras(r.Context(), roomID, id.SessionID, identity, nil, true)
		_ = s.refreshCamera(r.Context(), roomID, roomID, id.UserID, id.SessionID, identity)
		httpx.NoContent(w)
		return nil
	}
	room, err := s.getRoom(r.Context(), roomID)
	if err != nil {
		return err
	}
	s.releaseCamera(r.Context(), room.WorkspaceID, roomID, id.UserID, id.SessionID, identity, acc.Bits, nil, 0)
	httpx.NoContent(w)
	return nil
}

// stopMemberCamera: POST /api/rooms/{id}/voice/{userId}/stop-camera (MUTE_MEMBERS in the
// room, moderation hierarchy) → 204 | 404 when the member has neither a camera on nor a
// reservation. The stop is sticky for the member's devices in the room (BlockCamera).
func (s *Service) stopMemberCamera(w http.ResponseWriter, r *http.Request) error {
	room, target, sess, err := s.moderate(r)
	if err != nil {
		return err
	}
	acc, err := perm.NewResolver(s.db.Q).Room(r.Context(), room.ID, target)
	if err != nil && !errors.Is(err, perm.ErrNoRoom) {
		return err
	}
	name := voice.RoomName(room.WorkspaceID, room.ID)
	stopped := 0
	for _, st := range sess {
		identity := voice.Identity(st.UserID, st.SessionID)
		if err := s.voice.BlockCamera(r.Context(), identity); err != nil {
			return err
		}
		live := map[string]bool{}
		if p, err := s.lk.GetParticipant(r.Context(), name, identity); err == nil {
			for _, t := range p.Tracks {
				if t.Source == SourceCamera && !t.Muted {
					if err := s.lk.MuteTrack(r.Context(), name, identity, t.Sid, true); err != nil && !IsNotFound(err) {
						return httpx.Unavailable(err)
					}
					live[t.Sid] = true
				}
			}
		} else if !IsNotFound(err) {
			return httpx.Unavailable(err)
		}
		stopped += s.releaseCamera(r.Context(), room.WorkspaceID, room.ID, target, st.SessionID, identity, acc.Bits, live,
			v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_MODERATOR)
	}
	if stopped == 0 {
		return httpx.NotFound("camera of this member")
	}
	httpx.NoContent(w)
	return nil
}

// allowCamera: POST /api/rooms/{id}/voice/{userId}/allow-camera (MUTE_MEMBERS in the room,
// moderation hierarchy) → 204. Lifts a stop-camera for the member's devices in the room
// (they may be absent already: leaving lifts it anyway).
func (s *Service) allowCamera(w http.ResponseWriter, r *http.Request) error {
	_, target, sess, err := s.moderateAny(r)
	if err != nil {
		return err
	}
	for _, st := range sess {
		if err := s.voice.AllowCamera(r.Context(), voice.Identity(target, st.SessionID)); err != nil {
			return err
		}
	}
	httpx.NoContent(w)
	return nil
}

// releaseCamera ends a device's camera: drops its reservation and webcam records (plus
// the given live track sids), pushes a grant without the camera source and clears the
// device's camera flag. With a reason, VOICE_CAMERA_STOP is published for every track.
// Returns what was stopped: the tracks, plus one if only a reservation was dropped.
func (s *Service) releaseCamera(ctx context.Context, wid, rid, uid, sid uuid.UUID, identity string, bits perm.Bits,
	live map[string]bool, reason v1.VoiceStreamStopReason) int {
	hadReservation, err := s.voice.ReleaseCamera(ctx, identity)
	if err != nil {
		slog.WarnContext(ctx, "release camera", "identity", identity, "err", err)
	}
	tracks := map[string]bool{}
	for t := range live {
		tracks[t] = true
	}
	if cams, err := s.voice.Cameras(ctx, rid); err == nil {
		for t, c := range cams {
			if c.Identity == identity {
				tracks[t] = true
			}
		}
	}
	for t := range tracks {
		_, _ = s.voice.RemoveCamera(ctx, rid, t)
	}
	name := voice.RoomName(wid, rid)
	if err := s.pushGrant(ctx, name, identity, wid, uid, bits, s.streamHeld(ctx, rid, identity)); err != nil && !IsNotFound(err) {
		slog.WarnContext(ctx, "withdraw camera grant", "identity", identity, "err", err)
	}
	if reason != v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_UNSPECIFIED {
		for t := range tracks {
			s.publishCameraStop(ctx, wid, rid, uid, t, reason)
		}
	}
	_ = s.setFlag(ctx, wid, rid, uid, sid, func(n *voice.SessionState) { n.Camera = false })
	if len(tracks) == 0 && hadReservation {
		return 1
	}
	return len(tracks)
}

func (s *Service) publishCameraStop(ctx context.Context, wid, rid, uid uuid.UUID, trackSID string, reason v1.VoiceStreamStopReason) {
	s.publishScope(ctx, wid, rid, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceCameraStop{VoiceCameraStop: &v1.VoiceCameraStop{
		WorkspaceId: scopeWS(wid, rid), RoomId: rid.String(), UserId: uid.String(), TrackSid: trackSID, Reason: reason,
	}}})
}

// cameraStarted records a published webcam under camera_limit; an extra one is muted,
// loses the grant and VOICE_CAMERA_STOP{LIMIT_REACHED} goes out.
func (s *Service) cameraStarted(ctx context.Context, wid, rid, uid, sid uuid.UUID, identity string, t *Track) error {
	_, media, err := s.scopeInfo(ctx, wid, rid)
	if err != nil {
		return err
	}
	states, err := s.voice.List(ctx, wid)
	if err != nil {
		return err
	}
	if !hasState(states, sid, rid) {
		return nil // late event for a device not (or no longer) in the room; reconcile catches up
	}
	added, err := s.voice.AddCamera(ctx, rid, t.Sid, voice.Camera{Identity: identity, UserID: uid, Started: time.Now().UnixMilli()}, int(media.GetCameraLimit()))
	if err != nil {
		return err
	}
	if !added {
		room := voice.RoomName(wid, rid)
		if err := s.lk.MuteTrack(ctx, room, identity, t.Sid, true); err != nil && !IsNotFound(err) {
			slog.WarnContext(ctx, "mute over-limit camera", "err", err)
		}
		bits, err := s.scopeBits(ctx, wid, rid, uid)
		if err != nil {
			bits = 0
		}
		s.releaseCamera(ctx, wid, rid, uid, sid, identity, bits, nil, 0)
		s.publishCameraStop(ctx, wid, rid, uid, t.Sid, v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_LIMIT_REACHED)
		return nil
	}
	return s.setFlag(ctx, wid, rid, uid, sid, func(n *voice.SessionState) { n.Camera = true })
}

// cameraEnded handles track_unpublished of a webcam.
func (s *Service) cameraEnded(ctx context.Context, wid, rid, uid, sid uuid.UUID, identity, trackSID string) error {
	if _, err := s.voice.RemoveCamera(ctx, rid, trackSID); err != nil {
		return err
	}
	return s.refreshCamera(ctx, wid, rid, uid, sid, identity)
}

// refreshCamera sets the device's camera flag from its recorded webcams.
func (s *Service) refreshCamera(ctx context.Context, wid, rid, uid, sid uuid.UUID, identity string) error {
	cams, err := s.voice.Cameras(ctx, rid)
	if err != nil {
		return err
	}
	on := false
	for _, c := range cams {
		on = on || c.Identity == identity
	}
	return s.setFlag(ctx, wid, rid, uid, sid, func(n *voice.SessionState) { n.Camera = on })
}

// dropCameras forgets the webcams of a device connection that left room rid (no event:
// the device's voice state goes away with it), sparing the track sids in keep (a newer
// connection's). With keepHold — the identity reconnected meanwhile (a late participant_left
// of the old connection), or that is unknown — the reservation and a moderator's sticky stop
// stay: a reconnect must not lift the stop. A device that is in another room by now
// (app-level move, ADR-0019: only its old connection left) keeps them too.
func (s *Service) dropCameras(ctx context.Context, rid, sid uuid.UUID, identity string, keep map[string]bool, keepHold bool) {
	if cams, err := s.voice.Cameras(ctx, rid); err == nil {
		for t, c := range cams {
			if c.Identity == identity && !keep[t] {
				_, _ = s.voice.RemoveCamera(ctx, rid, t)
			}
		}
	}
	if keepHold {
		return
	}
	if _, cur, ok, err := s.voice.Location(ctx, sid); err == nil && ok && cur != rid {
		return
	}
	_, _ = s.voice.ReleaseCamera(ctx, identity)
	_ = s.voice.AllowCamera(ctx, identity) // a moderator's stop lasts until the device leaves
}

// resetCameraForReconnect forgets the webcam of a device moved at app level (ADR-0019):
// its records in the source room and its reservation go away; the moderator's sticky stop
// stays (same call). Reports whether the device had a camera on.
func (s *Service) resetCameraForReconnect(ctx context.Context, srcID uuid.UUID, identity string, cams map[string]voice.Camera) bool {
	had := false
	for t, c := range cams {
		if c.Identity == identity {
			if ok, _ := s.voice.RemoveCamera(ctx, srcID, t); ok {
				had = true
			}
		}
	}
	if _, err := s.voice.ReleaseCamera(ctx, identity); err != nil {
		slog.WarnContext(ctx, "release camera on app-level move", "identity", identity, "err", err)
	}
	return had
}

// reconcileCameras drops recorded webcams whose tracks are gone or muted and records live
// ones that were missed (same as reconcileStreams).
func (s *Service) reconcileCameras(ctx context.Context, wid, rid uuid.UUID, ps []Participant) {
	actual := map[string]Participant{}
	for _, p := range ps {
		for _, t := range p.Tracks {
			if t.Source == SourceCamera && !t.Muted {
				actual[t.Sid] = p
			}
		}
	}
	cams, err := s.voice.Cameras(ctx, rid)
	if err != nil {
		return
	}
	for t, c := range cams {
		if _, ok := actual[t]; !ok {
			if c.Started > 0 && time.Since(time.UnixMilli(c.Started)) < cameraGrace {
				continue // recorded after the participants were listed (L2)
			}
			if ok, _ := s.voice.RemoveCamera(ctx, rid, t); ok {
				if uid, sid, ok := voice.ParseIdentity(c.Identity); ok {
					_ = s.refreshCamera(ctx, wid, rid, uid, sid, c.Identity)
				}
			}
		}
	}
	for t, p := range actual {
		if _, ok := cams[t]; ok {
			continue
		}
		uid, sid, ok := voice.ParseIdentity(p.Identity)
		if !ok {
			continue
		}
		_ = s.cameraStarted(ctx, wid, rid, uid, sid, p.Identity, &Track{Sid: t, Source: SourceCamera})
	}
}
