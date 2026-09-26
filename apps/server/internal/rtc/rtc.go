// Package rtc issues LiveKit tokens, enforces voice permissions and stream limits, and keeps
// voice state in sync with LiveKit via webhooks and a periodic reconcile (docs/01, docs/04).
package rtc

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/calaba/calaba/server/internal/voice"
)

// Tunables (docs/01: token TTL 10 min, empty_timeout 300 s).
const (
	TokenTTL     = 10 * time.Minute
	EmptyTimeout = 300
)

// Config is the rtc part of the server config.
type Config struct {
	PublicURL       string // LIVEKIT_URL, given to clients
	APIKey, Secret  string
	MaxParticipants uint32
}

// Service implements the rtc endpoints and background sync.
type Service struct {
	cfg    Config
	db     *db.DB
	redis  rueidis.Client
	lk     LiveKit
	voice  voice.Store
	events events.Publisher
	// Revoked reports revoked auth sessions (set by the app); joins of revoked devices are kicked.
	Revoked func(ctx context.Context, sessionID uuid.UUID) (bool, error)
}

// NewService wires the rtc service. ev must be the plain publisher (not the Sync decorator).
func NewService(cfg Config, d *db.DB, r rueidis.Client, lk LiveKit, ev events.Publisher) *Service {
	return &Service{cfg: cfg, db: d, redis: r, lk: lk, voice: voice.Store{C: r}, events: ev}
}

// Routes registers the rtc routes. The webhook is public (signature-checked).
func (s *Service) Routes(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /api/rooms/{id}/join", wrap(httpx.HandlerFunc(s.join)))
	mux.Handle("POST /api/rooms/{id}/stream/request", wrap(httpx.HandlerFunc(s.requestStream)))
	mux.Handle("PATCH /api/voice/self", wrap(httpx.HandlerFunc(s.voiceSelf)))
	mux.Handle("POST /api/rooms/{id}/voice/{userId}/mute", wrap(httpx.HandlerFunc(s.muteMember)))
	mux.Handle("POST /api/rooms/{id}/voice/{userId}/unmute", wrap(httpx.HandlerFunc(s.unmuteMember)))
	mux.Handle("POST /api/rooms/{id}/voice/{userId}/disconnect", wrap(httpx.HandlerFunc(s.disconnectMember)))
	mux.Handle("POST /api/rooms/{id}/voice/{userId}/stop-stream", wrap(httpx.HandlerFunc(s.stopStream)))
	mux.Handle("POST /api/rooms/{id}/voice/{userId}/move", wrap(httpx.HandlerFunc(s.moveMember)))
	mux.Handle("POST /api/rtc/webhook", httpx.HandlerFunc(s.webhook))
}

// roomInfo loads a live room with its effective media settings.
func (s *Service) roomInfo(ctx context.Context, roomID uuid.UUID) (sqlc.Room, *v1.RoomMediaSettings, error) {
	room, err := s.db.Q.GetRoom(ctx, roomID)
	if err != nil {
		return room, nil, err
	}
	ws, err := s.db.Q.GetWorkspace(ctx, room.WorkspaceID)
	if err != nil {
		return room, nil, err
	}
	return room, pbconv.EffectiveMedia(room, pbconv.WorkspaceDefaults(ws)), nil
}

// streamSlotFree reports whether identity may start a stream: fewer than max streams by
// other participants are active.
func (s *Service) streamSlotFree(ctx context.Context, roomID uuid.UUID, identity string, maxStreams uint32) (bool, error) {
	streams, err := s.voice.Streams(ctx, roomID)
	if err != nil {
		return false, err
	}
	n := uint32(0)
	for _, st := range streams {
		if st.Identity != identity {
			n++
		}
	}
	return n < maxStreams, nil
}

func (s *Service) displayName(ctx context.Context, wsID, userID uuid.UUID) string {
	rows, err := s.db.Q.ListMemberNames(ctx, sqlc.ListMemberNamesParams{WorkspaceID: wsID, UserIds: []uuid.UUID{userID}})
	if err != nil || len(rows) == 0 {
		return ""
	}
	name, _ := rows[0].Name.(string)
	return name
}

func (s *Service) join(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.Connect) {
		return httpx.Forbidden("CONNECT required")
	}
	room, media, err := s.roomInfo(r.Context(), roomID)
	if err != nil {
		return err
	}
	if room.Type != "voice" {
		return httpx.Validation("id", "not a voice room")
	}
	id := auth.MustFromContext(r.Context())
	identity := voice.Identity(id.UserID, id.SessionID)
	name := voice.RoomName(room.WorkspaceID, room.ID)
	if room.UserLimit > 0 && !acc.Bits.Has(perm.MoveMembers) {
		full, err := s.roomFull(r.Context(), room.WorkspaceID, room.ID, int(room.UserLimit), id.UserID)
		if err != nil {
			return err
		}
		if full {
			return errRoomFull
		}
	}
	if err := s.lk.CreateRoom(r.Context(), name, EmptyTimeout, s.cfg.MaxParticipants); err != nil {
		return httpx.Unavailable(err)
	}
	slot := false
	if acc.Bits.Has(perm.Stream) {
		if slot, err = s.streamSlotFree(r.Context(), roomID, identity, media.GetMaxStreams()); err != nil {
			return err
		}
	}
	tok, err := JoinToken(s.cfg.APIKey, s.cfg.Secret, name, identity,
		s.displayName(r.Context(), room.WorkspaceID, id.UserID), s.grant(r.Context(), room.WorkspaceID, id.UserID, acc.Bits, slot), TokenTTL)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.JoinVoiceResponse{
		Url: s.cfg.PublicURL, Token: tok, Identity: identity, Media: media,
		CanSpeak: s.canSpeak(r.Context(), room.WorkspaceID, id.UserID, acc.Bits), CanStream: slot,
	})
	return nil
}

func (s *Service) requestStream(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.Connect | perm.Stream) {
		return httpx.Forbidden("STREAM required")
	}
	var req v1.RequestStreamRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	room, media, err := s.roomInfo(r.Context(), roomID)
	if err != nil {
		return err
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
	free, err := s.streamSlotFree(r.Context(), roomID, identity, media.GetMaxStreams())
	if err != nil {
		return err
	}
	if !free {
		return httpx.Conflict("stream limit of the room is reached")
	}
	preset := ClampPreset(req.GetPreset(), media.GetMaxStreamPreset())
	if err := s.voice.ReserveStream(r.Context(), identity, preset); err != nil {
		return err
	}
	if err := s.lk.UpdatePermission(r.Context(), name, identity, s.grant(r.Context(), room.WorkspaceID, id.UserID, acc.Bits, true)); err != nil {
		return httpx.Unavailable(err)
	}
	httpx.Write(w, http.StatusOK, &v1.RequestStreamResponse{Preset: preset})
	return nil
}

// serverMuted reports a moderator's mute; a Redis error counts as not muted (logged).
func (s *Service) serverMuted(ctx context.Context, wid, uid uuid.UUID) bool {
	sm, err := s.voice.ServerMuted(ctx, wid, uid)
	if err != nil {
		slog.WarnContext(ctx, "read server mute", "user", uid, "err", err)
	}
	return sm
}

// grant is Grant for a concrete user: a server-muted user loses the microphone source, so
// the SFU itself refuses to publish or unmute a microphone track.
func (s *Service) grant(ctx context.Context, wid, uid uuid.UUID, bits perm.Bits, slot bool) Permission {
	if bits.Has(perm.Speak) && s.serverMuted(ctx, wid, uid) {
		bits &^= perm.Speak
	}
	return Grant(bits, slot)
}

func (s *Service) canSpeak(ctx context.Context, wid, uid uuid.UUID, bits perm.Bits) bool {
	return bits.Has(perm.Speak) && !s.serverMuted(ctx, wid, uid)
}

func (s *Service) publishVoice(ctx context.Context, wsID uuid.UUID, c voice.Change) {
	if c.Changed() {
		s.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceStateUpdate{
			VoiceStateUpdate: &v1.VoiceStateUpdate{State: c.After},
		}})
	}
	for _, rid := range c.Calls {
		s.publishCall(ctx, wsID, rid)
	}
}

// publishCall announces a call start or end as ROOM_UPDATE carrying voice_started_at, so
// every client counts the call timer from server time. The start is re-read from Redis at
// publish time: if a start and an end race, the later event carries the current state.
func (s *Service) publishCall(ctx context.Context, wsID, rid uuid.UUID) {
	row, err := s.db.Q.GetRoom(ctx, rid)
	if err != nil {
		return // room deleted meanwhile: ROOM_DELETE covers it
	}
	room, err := rooms.Load(ctx, s.db.Q, row)
	if err != nil {
		slog.WarnContext(ctx, "load room for call update", "room", rid, "err", err)
		return
	}
	s.fillStarted(ctx, room)
	s.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomUpdate{RoomUpdate: &v1.RoomUpdate{Room: room}}})
}

// fillStarted sets room.voice_started_at from Redis (unset when nobody is in the call).
func (s *Service) fillStarted(ctx context.Context, room *v1.Room) {
	if room.GetType() != v1.RoomType_ROOM_TYPE_VOICE {
		return
	}
	rid, err := uuid.Parse(room.GetId())
	if err != nil {
		return
	}
	room.VoiceStartedAt = nil
	if started, err := s.voice.StartedAt(ctx, []uuid.UUID{rid}); err == nil {
		if t, ok := started[rid]; ok {
			room.VoiceStartedAt = timestamppb.New(t)
		}
	}
}

func (s *Service) voiceSelf(w http.ResponseWriter, r *http.Request) error {
	var req v1.UpdateVoiceSelfRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	id := auth.MustFromContext(r.Context())
	wsID, _, ok, err := s.voice.Location(r.Context(), id.SessionID)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.Conflict("not connected to a voice room")
	}
	if req.Muted != nil && !req.GetMuted() && s.serverMuted(r.Context(), wsID, id.UserID) {
		return httpx.Forbidden("muted by a moderator")
	}
	c, err := s.voice.Update(r.Context(), wsID, id.UserID, id.SessionID, func(cur *voice.SessionState) *voice.SessionState {
		if cur == nil {
			return nil
		}
		n := *cur
		if req.Muted != nil {
			n.Muted = req.GetMuted()
		}
		if req.Deafened != nil {
			n.Deafened = req.GetDeafened()
		}
		return &n
	})
	if err != nil {
		return err
	}
	s.publishVoice(r.Context(), wsID, c)
	httpx.NoContent(w)
	return nil
}

// memberSessions returns the device sessions of userID connected to roomID.
func (s *Service) memberSessions(ctx context.Context, wsID, roomID, userID uuid.UUID) ([]voice.SessionState, error) {
	all, err := s.voice.List(ctx, wsID)
	if err != nil {
		return nil, err
	}
	var out []voice.SessionState
	for _, st := range all {
		if st.UserID == userID && st.RoomID == roomID {
			out = append(out, st)
		}
	}
	return out, nil
}

func (s *Service) moderate(r *http.Request) (sqlc.Room, uuid.UUID, []voice.SessionState, error) {
	room, target, sess, err := s.moderateAny(r)
	if err == nil && len(sess) == 0 {
		err = httpx.NotFound("member in this voice room")
	}
	return room, target, sess, err
}

// moderateAny checks MUTE_MEMBERS in the path room and the moderation hierarchy; the
// target's devices in that room may be none (e.g. unmute after they left).
func (s *Service) moderateAny(r *http.Request) (sqlc.Room, uuid.UUID, []voice.SessionState, error) {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return sqlc.Room{}, uuid.Nil, nil, err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return sqlc.Room{}, uuid.Nil, nil, err
	}
	if !acc.Bits.Has(perm.MuteMembers) {
		return sqlc.Room{}, uuid.Nil, nil, httpx.Forbidden("MUTE_MEMBERS required")
	}
	target, err := httpx.PathUUID(r, "userId", "member")
	if err != nil {
		return sqlc.Room{}, uuid.Nil, nil, err
	}
	if err := outranks(r, acc.WorkspaceID, target); err != nil {
		return sqlc.Room{}, uuid.Nil, nil, err
	}
	room, err := s.db.Q.GetRoom(r.Context(), roomID)
	if err != nil {
		return room, target, nil, err
	}
	sess, err := s.memberSessions(r.Context(), room.WorkspaceID, roomID, target)
	if err != nil {
		return room, target, nil, err
	}
	return room, target, sess, nil
}

// muteMember server-mutes the member (VoiceState.server_muted) until a moderator unmutes:
// the microphone source is withdrawn from the grants of all their devices (LiveKit then
// refuses to publish or unmute it) and published microphone tracks are muted.
func (s *Service) muteMember(w http.ResponseWriter, r *http.Request) error {
	room, target, sess, err := s.moderate(r)
	if err != nil {
		return err
	}
	c, err := s.voice.SetServerMuted(r.Context(), room.WorkspaceID, target, true)
	if err != nil {
		return err
	}
	s.publishVoice(r.Context(), room.WorkspaceID, c)
	s.resync(r.Context(), room.WorkspaceID, func(st voice.SessionState) bool { return st.UserID == target })
	name := voice.RoomName(room.WorkspaceID, room.ID)
	for _, st := range sess {
		identity := voice.Identity(st.UserID, st.SessionID)
		p, err := s.lk.GetParticipant(r.Context(), name, identity)
		if err != nil {
			continue
		}
		for _, t := range p.Tracks {
			if t.Source == SourceMicrophone && !t.Muted {
				if err := s.lk.MuteTrack(r.Context(), name, identity, t.Sid, true); err != nil && !IsNotFound(err) {
					return httpx.Unavailable(err)
				}
			}
		}
		c, err := s.voice.Update(r.Context(), room.WorkspaceID, target, st.SessionID, func(cur *voice.SessionState) *voice.SessionState {
			if cur == nil {
				return nil
			}
			n := *cur
			n.Muted = true
			return &n
		})
		if err == nil {
			s.publishVoice(r.Context(), room.WorkspaceID, c)
		}
	}
	httpx.NoContent(w)
	return nil
}

// unmuteMember lifts a server mute (MUTE_MEMBERS; the member cannot lift it). The
// microphone grant is restored; the member unmutes themselves.
func (s *Service) unmuteMember(w http.ResponseWriter, r *http.Request) error {
	room, target, _, err := s.moderateAny(r)
	if err != nil {
		return err
	}
	c, err := s.voice.SetServerMuted(r.Context(), room.WorkspaceID, target, false)
	if err != nil {
		return err
	}
	s.publishVoice(r.Context(), room.WorkspaceID, c)
	s.resync(r.Context(), room.WorkspaceID, func(st voice.SessionState) bool { return st.UserID == target })
	httpx.NoContent(w)
	return nil
}

// stopStream stops the member's screen shares on all devices: tracks are muted server-side,
// the screen share grant is withdrawn (a new stream needs /stream/request) and
// VOICE_STREAM_STOP{MODERATOR} is published.
func (s *Service) stopStream(w http.ResponseWriter, r *http.Request) error {
	room, target, sess, err := s.moderate(r)
	if err != nil {
		return err
	}
	name := voice.RoomName(room.WorkspaceID, room.ID)
	acc, err := perm.NewResolver(s.db.Q).Room(r.Context(), room.ID, target)
	if err != nil && !errors.Is(err, perm.ErrNoRoom) {
		return err
	}
	streams, err := s.voice.Streams(r.Context(), room.ID)
	if err != nil {
		return err
	}
	stopped := 0
	for _, st := range sess {
		identity := voice.Identity(st.UserID, st.SessionID)
		muted := map[string]bool{}
		if p, err := s.lk.GetParticipant(r.Context(), name, identity); err == nil {
			for _, t := range p.Tracks {
				if (t.Source == SourceScreenShare || t.Source == SourceScreenShareAudio) && !t.Muted {
					if err := s.lk.MuteTrack(r.Context(), name, identity, t.Sid, true); err != nil && !IsNotFound(err) {
						return httpx.Unavailable(err)
					}
					muted[t.Sid] = true
				}
			}
		} else if !IsNotFound(err) {
			return httpx.Unavailable(err)
		}
		if err := s.lk.UpdatePermission(r.Context(), name, identity, s.grant(r.Context(), room.WorkspaceID, st.UserID, acc.Bits, false)); err != nil && !IsNotFound(err) {
			return httpx.Unavailable(err)
		}
		// Recorded streams of this device (also covers tracks LiveKit no longer reports).
		for sid, rec := range streams {
			if rec.Identity == identity {
				muted[sid] = true
			}
		}
		for sid := range muted {
			if ok, _ := s.voice.RemoveStream(r.Context(), room.ID, sid); ok {
				s.publishStreamStop(r.Context(), room.WorkspaceID, room.ID, target, sid, v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_MODERATOR)
				stopped++
			}
		}
		c, err := s.voice.Update(r.Context(), room.WorkspaceID, target, st.SessionID, func(cur *voice.SessionState) *voice.SessionState {
			if cur == nil {
				return nil
			}
			n := *cur
			n.Streaming = false
			return &n
		})
		if err == nil {
			s.publishVoice(r.Context(), room.WorkspaceID, c)
		}
	}
	if stopped == 0 {
		return httpx.NotFound("stream of this member")
	}
	httpx.NoContent(w)
	return nil
}

func (s *Service) disconnectMember(w http.ResponseWriter, r *http.Request) error {
	room, _, sess, err := s.moderate(r)
	if err != nil {
		return err
	}
	name := voice.RoomName(room.WorkspaceID, room.ID)
	for _, st := range sess {
		if err := s.lk.RemoveParticipant(r.Context(), name, voice.Identity(st.UserID, st.SessionID)); err != nil && !IsNotFound(err) {
			return httpx.Unavailable(err)
		}
		// Voice state is cleared by the participant_left webhook (or reconcile).
	}
	httpx.NoContent(w)
	return nil
}

// removeIdentities disconnects identities from a room; not-found is fine.
func (s *Service) removeIdentities(ctx context.Context, room string, ids []string) {
	for _, id := range ids {
		if err := s.lk.RemoveParticipant(ctx, room, id); err != nil && !IsNotFound(err) {
			slog.WarnContext(ctx, "livekit remove participant", "room", room, "identity", id, "err", err)
		}
	}
}

var errRoomFull = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_ROOM_FULL, "the room is full")

// roomFull reports whether the room already has `limit` distinct users other than self
// (a user already inside, e.g. joining from a second device, does not take a new place).
func (s *Service) roomFull(ctx context.Context, wid, rid uuid.UUID, limit int, self uuid.UUID) (bool, error) {
	states, err := s.voice.List(ctx, wid)
	if err != nil {
		return false, err
	}
	users := map[uuid.UUID]bool{}
	for _, st := range states {
		if st.RoomID == rid {
			if st.UserID == self {
				return false, nil
			}
			users[st.UserID] = true
		}
	}
	return len(users) >= limit, nil
}

func rank(r perm.Role) int {
	switch r {
	case perm.RoleOwner:
		return 3
	case perm.RoleAdmin:
		return 2
	}
	return 1
}

// outranks enforces the moderation hierarchy for mute/disconnect/stop-stream/move: the
// owner is untouchable, an admin can be moderated only by the owner; moderators among
// members (via room overrides) act on members and guests only. Acting on oneself is fine.
func outranks(r *http.Request, wsID, target uuid.UUID) error {
	actor := auth.MustFromContext(r.Context()).UserID
	if actor == target {
		return nil
	}
	res := perm.FromContext(r.Context())
	ar, err := res.Role(r.Context(), wsID, actor)
	if err != nil {
		return err
	}
	tr, err := res.Role(r.Context(), wsID, target)
	if errors.Is(err, perm.ErrNotMember) {
		return httpx.NotFound("member")
	}
	if err != nil {
		return err
	}
	if rank(tr) >= 2 && rank(ar) <= rank(tr) {
		return httpx.Forbidden("cannot moderate a member of equal or higher rank")
	}
	return nil
}

// DisabledRoutes answers rtc endpoints with 503 when LiveKit is not configured.
func DisabledRoutes(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	h := httpx.HandlerFunc(func(http.ResponseWriter, *http.Request) error {
		return httpx.Unavailable(errors.New("rtc: LiveKit is not configured"))
	})
	for _, p := range []string{"POST /api/rooms/{id}/join", "POST /api/rooms/{id}/stream/request", "PATCH /api/voice/self",
		"POST /api/rooms/{id}/voice/{userId}/mute", "POST /api/rooms/{id}/voice/{userId}/unmute", "POST /api/rooms/{id}/voice/{userId}/disconnect",
		"POST /api/rooms/{id}/voice/{userId}/stop-stream", "POST /api/rooms/{id}/voice/{userId}/move"} {
		mux.Handle(p, wrap(h))
	}
	mux.Handle("POST /api/rtc/webhook", h)
}
