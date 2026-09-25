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
	mux.Handle("POST /api/rooms/{id}/voice/{userId}/disconnect", wrap(httpx.HandlerFunc(s.disconnectMember)))
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
		s.displayName(r.Context(), room.WorkspaceID, id.UserID), Grant(acc.Bits, slot), TokenTTL)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.JoinVoiceResponse{
		Url: s.cfg.PublicURL, Token: tok, Identity: identity, Media: media,
		CanSpeak: acc.Bits.Has(perm.Speak), CanStream: slot,
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
	if err := s.lk.UpdatePermission(r.Context(), name, identity, Grant(acc.Bits, true)); err != nil {
		return httpx.Unavailable(err)
	}
	httpx.Write(w, http.StatusOK, &v1.RequestStreamResponse{Preset: preset})
	return nil
}

func (s *Service) publishVoice(ctx context.Context, wsID uuid.UUID, c voice.Change) {
	if c.Changed() {
		s.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceStateUpdate{
			VoiceStateUpdate: &v1.VoiceStateUpdate{State: c.After},
		}})
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
	room, err := s.db.Q.GetRoom(r.Context(), roomID)
	if err != nil {
		return room, target, nil, err
	}
	sess, err := s.memberSessions(r.Context(), room.WorkspaceID, roomID, target)
	if err != nil {
		return room, target, nil, err
	}
	if len(sess) == 0 {
		return room, target, nil, httpx.NotFound("member in this voice room")
	}
	return room, target, sess, nil
}

// muteMember server-mutes the member's microphone tracks on all of their devices.
func (s *Service) muteMember(w http.ResponseWriter, r *http.Request) error {
	room, target, sess, err := s.moderate(r)
	if err != nil {
		return err
	}
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

// DisabledRoutes answers rtc endpoints with 503 when LiveKit is not configured.
func DisabledRoutes(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	h := httpx.HandlerFunc(func(http.ResponseWriter, *http.Request) error {
		return httpx.Unavailable(errors.New("rtc: LiveKit is not configured"))
	})
	for _, p := range []string{"POST /api/rooms/{id}/join", "POST /api/rooms/{id}/stream/request", "PATCH /api/voice/self",
		"POST /api/rooms/{id}/voice/{userId}/mute", "POST /api/rooms/{id}/voice/{userId}/disconnect"} {
		mux.Handle(p, wrap(h))
	}
	mux.Handle("POST /api/rtc/webhook", h)
}
