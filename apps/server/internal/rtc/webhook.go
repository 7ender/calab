package rtc

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"io"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/voice"
)

// webhook receives LiveKit events. The request is authenticated by LiveKit's signed JWT
// (API key/secret) that carries the body sha256.
func (s *Service) webhook(w http.ResponseWriter, r *http.Request) error {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		return httpx.BadRequest("cannot read body")
	}
	ev, err := VerifyWebhook(s.cfg.APIKey, s.cfg.Secret, r.Header.Get("Authorization"), body)
	if err != nil {
		return httpx.Unauthenticated("invalid webhook signature")
	}
	// LiveKit retries: handle each event once. The key is claimed before handling (so a
	// concurrent redelivery is skipped) and released again if handling fails, so that the
	// retry is processed instead of being swallowed as a duplicate.
	key := ""
	if ev.ID != "" {
		key = "rtc:wh:" + ev.ID
		set := s.redis.B().Set().Key(key).Value("1").Nx().Ex(24 * time.Hour).Build()
		if err := s.redis.Do(r.Context(), set).Error(); rueidis.IsRedisNil(err) {
			w.WriteHeader(http.StatusOK)
			return nil
		} else if err != nil {
			return httpx.Unavailable(err)
		}
	}
	if err := s.HandleEvent(r.Context(), ev); err != nil {
		if key != "" {
			_ = s.redis.Do(context.WithoutCancel(r.Context()), s.redis.B().Del().Key(key).Build()).Error()
		}
		return err
	}
	w.WriteHeader(http.StatusOK)
	return nil
}

func micMuted(p *Participant) bool {
	if p == nil {
		return true
	}
	for _, t := range p.Tracks {
		if t.Source == SourceMicrophone && !t.Muted {
			return false
		}
	}
	return true
}

// HandleEvent applies one LiveKit webhook event to voice state and publishes gateway events.
func (s *Service) HandleEvent(ctx context.Context, ev *WebhookEvent) error {
	if ev.Room == nil {
		return nil
	}
	wid, rid, ok := voice.ParseRoomName(ev.Room.Name)
	if !ok {
		return nil // not a Calaba room
	}
	if ev.Event == EventRoomFinished {
		return s.roomFinished(ctx, wid, rid)
	}
	p := ev.Participant
	if p == nil {
		return nil
	}
	uid, sid, ok := voice.ParseIdentity(p.Identity)
	if !ok {
		return nil
	}
	identity := p.Identity
	t := ev.Track
	if t == nil {
		t = &Track{}
	}
	switch ev.Event {
	case EventParticipantJoined:
		return s.participantJoined(ctx, wid, rid, uid, sid, ev.Room.Name, p)
	case EventParticipantLeft, EventParticipantAborted:
		s.stopStreams(ctx, wid, rid, identity, v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_ENDED)
		return s.update(ctx, wid, uid, sid, func(cur *voice.SessionState) *voice.SessionState {
			if cur == nil || cur.RoomID != rid {
				return cur // the device already moved to another room
			}
			return nil
		})
	case EventTrackPublished:
		switch t.Source {
		case SourceMicrophone:
			return s.setFlag(ctx, wid, rid, uid, sid, func(n *voice.SessionState) { n.Muted = t.Muted })
		case SourceScreenShare:
			return s.streamStarted(ctx, wid, rid, uid, sid, identity, t)
		}
	case EventTrackUnpublished:
		switch t.Source {
		case SourceMicrophone:
			return s.setFlag(ctx, wid, rid, uid, sid, func(n *voice.SessionState) { n.Muted = true })
		case SourceScreenShare:
			removed, err := s.voice.RemoveStream(ctx, rid, t.Sid)
			if err != nil || !removed {
				return err
			}
			s.publishStreamStop(ctx, wid, rid, uid, t.Sid, v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_ENDED)
			return s.refreshStreaming(ctx, wid, rid, uid, sid, identity)
		}
	}
	return nil
}

func (s *Service) update(ctx context.Context, wid, uid, sid uuid.UUID, fn func(*voice.SessionState) *voice.SessionState) error {
	c, err := s.voice.Update(ctx, wid, uid, sid, fn)
	if err != nil {
		return err
	}
	s.publishVoice(ctx, wid, c)
	return nil
}

// setFlag changes a device's flags if it is connected to rid. Late track events (after
// participant_left, or for a device that moved) must not resurrect a "ghost" state.
func (s *Service) setFlag(ctx context.Context, wid, rid, uid, sid uuid.UUID, fn func(*voice.SessionState)) error {
	return s.update(ctx, wid, uid, sid, func(cur *voice.SessionState) *voice.SessionState {
		if cur == nil || cur.RoomID != rid {
			return cur
		}
		n := *cur
		fn(&n)
		return &n
	})
}

// participantJoined admits a device that connected to LiveKit. A join token lives 10 min,
// so everything it was issued for is re-checked now (security review H2): the session is
// not revoked, the user still has VIEW_ROOM+CONNECT, and the room's user_limit is not
// exceeded. The limit check and the state write happen under the workspace voice lock, so
// concurrent joins cannot all squeeze in. Rejected devices are removed from LiveKit.
func (s *Service) participantJoined(ctx context.Context, wid, rid, uid, sid uuid.UUID, lkRoom string, p *Participant) error {
	identity := p.Identity
	reject := func(reason string) error {
		slog.InfoContext(ctx, "voice join rejected", "identity", identity, "reason", reason)
		s.removeIdentities(ctx, lkRoom, []string{identity})
		return nil
	}
	if s.Revoked != nil {
		if revoked, err := s.Revoked(ctx, sid); err != nil {
			return err
		} else if revoked {
			return reject("session revoked")
		}
	}
	acc, err := perm.NewResolver(s.db.Q).Room(ctx, rid, uid)
	if errors.Is(err, perm.ErrNoRoom) {
		return reject("no access to the room")
	}
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.ViewRoom | perm.Connect) {
		return reject("missing CONNECT")
	}
	room, media, err := s.roomInfo(ctx, rid)
	if err != nil {
		return err
	}
	muted := micMuted(p)
	var (
		full bool
		c    voice.Change
	)
	err = s.voice.WithLock(ctx, wid, func() error {
		if room.UserLimit > 0 && !acc.Bits.Has(perm.MoveMembers) {
			var err error
			if full, err = s.roomFull(ctx, wid, rid, int(room.UserLimit), uid); err != nil || full {
				return err
			}
		}
		var err error
		c, err = s.voice.UpdateLocked(ctx, wid, uid, sid, func(cur *voice.SessionState) *voice.SessionState {
			n := voice.SessionState{RoomID: rid, Muted: muted}
			if cur != nil && cur.RoomID == rid {
				n = *cur
				n.Muted = muted
			}
			return &n
		})
		return err
	})
	if err != nil {
		return err
	}
	if full {
		return reject("room is full")
	}
	s.publishVoice(ctx, wid, c)
	// The token's grant may be stale: align it with the current permissions.
	slot := false
	if acc.Bits.Has(perm.Stream) {
		slot, _ = s.streamSlotFree(ctx, rid, identity, media.GetMaxStreams())
	}
	if err := s.lk.UpdatePermission(ctx, lkRoom, identity, Grant(acc.Bits, slot)); err != nil && !IsNotFound(err) {
		slog.WarnContext(ctx, "livekit update permission on join", "identity", identity, "err", err)
	}
	return nil
}

func (s *Service) refreshStreaming(ctx context.Context, wid, rid, uid, sid uuid.UUID, identity string) error {
	streams, err := s.voice.Streams(ctx, rid)
	if err != nil {
		return err
	}
	on := false
	for _, st := range streams {
		on = on || st.Identity == identity
	}
	return s.setFlag(ctx, wid, rid, uid, sid, func(n *voice.SessionState) { n.Streaming = on })
}

func (s *Service) publishStreamStop(ctx context.Context, wid, rid, uid uuid.UUID, trackSID string, reason v1.VoiceStreamStopReason) {
	s.events.Workspace(ctx, wid, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceStreamStop{VoiceStreamStop: &v1.VoiceStreamStop{
		WorkspaceId: wid.String(), RoomId: rid.String(), UserId: uid.String(), TrackSid: trackSID, Reason: reason,
	}}})
}

// streamStarted enforces max_streams: a stream beyond the limit is muted server-side and the
// publisher loses the screen share grant.
func (s *Service) streamStarted(ctx context.Context, wid, rid, uid, sid uuid.UUID, identity string, t *Track) error {
	_, media, err := s.roomInfo(ctx, rid)
	if err != nil {
		return err
	}
	states, err := s.voice.List(ctx, wid)
	if err != nil {
		return err
	}
	if !hasState(states, sid, rid) {
		return nil // late event for a device that is not (or no longer) in the room; reconcile catches up
	}
	preset := s.voice.ReservedStream(ctx, identity)
	preset = ClampPreset(preset, media.GetMaxStreamPreset())
	added, err := s.voice.AddStream(ctx, rid, t.Sid, voice.Stream{Identity: identity, UserID: uid, Preset: preset, Started: time.Now().UnixMilli()}, int(media.GetMaxStreams()))
	if err != nil {
		return err
	}
	if !added {
		room := voice.RoomName(wid, rid)
		if err := s.lk.MuteTrack(ctx, room, identity, t.Sid, true); err != nil && !IsNotFound(err) {
			slog.WarnContext(ctx, "mute over-limit stream", "err", err)
		}
		if acc, err := perm.NewResolver(s.db.Q).Room(ctx, rid, uid); err == nil {
			_ = s.lk.UpdatePermission(ctx, room, identity, Grant(acc.Bits, false))
		}
		s.publishStreamStop(ctx, wid, rid, uid, t.Sid, v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_LIMIT_REACHED)
		return nil
	}
	s.events.Workspace(ctx, wid, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceStreamStart{VoiceStreamStart: &v1.VoiceStreamStart{
		WorkspaceId: wid.String(), RoomId: rid.String(), UserId: uid.String(), TrackSid: t.Sid, Preset: preset,
	}}})
	return s.setFlag(ctx, wid, rid, uid, sid, func(n *voice.SessionState) { n.Streaming = true })
}

func (s *Service) stopStreams(ctx context.Context, wid, rid uuid.UUID, identity string, reason v1.VoiceStreamStopReason) {
	streams, err := s.voice.Streams(ctx, rid)
	if err != nil {
		return
	}
	for sidTrack, st := range streams {
		if st.Identity != identity {
			continue
		}
		if ok, _ := s.voice.RemoveStream(ctx, rid, sidTrack); ok {
			s.publishStreamStop(ctx, wid, rid, st.UserID, sidTrack, reason)
		}
	}
}

func (s *Service) roomFinished(ctx context.Context, wid, rid uuid.UUID) error {
	states, err := s.voice.List(ctx, wid)
	if err != nil {
		return err
	}
	for _, st := range states {
		if st.RoomID == rid {
			if err := s.update(ctx, wid, st.UserID, st.SessionID, func(*voice.SessionState) *voice.SessionState { return nil }); err != nil {
				return err
			}
		}
	}
	return s.voice.ClearRoom(ctx, rid)
}
