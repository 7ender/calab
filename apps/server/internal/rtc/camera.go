package rtc

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

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
//     keep it; stopping a camera (own or by a moderator) releases both.

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

// requestCamera: POST /api/rooms/{id}/camera/request → 204 | 409 (limit reached, cameras
// off, not in the call).
func (s *Service) requestCamera(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.Connect | perm.Video) {
		return httpx.Forbidden("VIDEO required")
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
	httpx.NoContent(w)
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
	room, err := s.db.Q.GetRoom(r.Context(), roomID)
	if err != nil {
		return err
	}
	id := auth.MustFromContext(r.Context())
	identity := voice.Identity(id.UserID, id.SessionID)
	s.releaseCamera(r.Context(), room.WorkspaceID, roomID, id.UserID, id.SessionID, identity, acc.Bits, nil, 0)
	httpx.NoContent(w)
	return nil
}

// stopMemberCamera: POST /api/rooms/{id}/voice/{userId}/stop-camera (MUTE_MEMBERS in the
// room, moderation hierarchy) → 204 | 404 when the member has no camera on.
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

// releaseCamera ends a device's camera: drops its reservation and webcam records (plus
// the given live track sids), pushes a grant without the camera source and clears the
// device's camera flag. With a reason, VOICE_CAMERA_STOP is published for every track.
// Returns the number of tracks stopped.
func (s *Service) releaseCamera(ctx context.Context, wid, rid, uid, sid uuid.UUID, identity string, bits perm.Bits,
	live map[string]bool, reason v1.VoiceStreamStopReason) int {
	if err := s.voice.ReleaseCamera(ctx, identity); err != nil {
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
	return len(tracks)
}

func (s *Service) publishCameraStop(ctx context.Context, wid, rid, uid uuid.UUID, trackSID string, reason v1.VoiceStreamStopReason) {
	s.events.Workspace(ctx, wid, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceCameraStop{VoiceCameraStop: &v1.VoiceCameraStop{
		WorkspaceId: wid.String(), RoomId: rid.String(), UserId: uid.String(), TrackSid: trackSID, Reason: reason,
	}}})
}

// cameraStarted records a published webcam under camera_limit; an extra one is muted,
// loses the grant and VOICE_CAMERA_STOP{LIMIT_REACHED} goes out.
func (s *Service) cameraStarted(ctx context.Context, wid, rid, uid, sid uuid.UUID, identity string, t *Track) error {
	_, media, err := s.roomInfo(ctx, rid)
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
	added, err := s.voice.AddCamera(ctx, rid, t.Sid, voice.Camera{Identity: identity, UserID: uid}, int(media.GetCameraLimit()))
	if err != nil {
		return err
	}
	if !added {
		room := voice.RoomName(wid, rid)
		if err := s.lk.MuteTrack(ctx, room, identity, t.Sid, true); err != nil && !IsNotFound(err) {
			slog.WarnContext(ctx, "mute over-limit camera", "err", err)
		}
		acc, err := perm.NewResolver(s.db.Q).Room(ctx, rid, uid)
		if err != nil {
			acc = perm.RoomAccess{}
		}
		s.releaseCamera(ctx, wid, rid, uid, sid, identity, acc.Bits, nil, 0)
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

// dropCameras forgets the webcams of a device that left (no event: the device's voice
// state goes away with it).
func (s *Service) dropCameras(ctx context.Context, rid uuid.UUID, identity string) {
	cams, err := s.voice.Cameras(ctx, rid)
	if err != nil {
		return
	}
	for t, c := range cams {
		if c.Identity == identity {
			_, _ = s.voice.RemoveCamera(ctx, rid, t)
		}
	}
	_ = s.voice.ReleaseCamera(ctx, identity)
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
