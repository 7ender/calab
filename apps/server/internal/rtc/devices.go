package rtc

import (
	"context"
	"log/slog"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/voice"
)

// One device in voice at a time (owner 29.09, docs/05 "Несколько устройств"): a /join from
// device B — a workspace room or a one-to-one call, any scope — takes the user's other devices
// out of voice. Each of them gets VOICE_DISCONNECTED{OTHER_DEVICE} (and leaves without a
// reconnect attempt), its LiveKit participant is removed and its voice state cleared
// (VOICE_STATE_UPDATE). The same session (a repeated /join, a reconnect, a move) is never
// touched. Moves by a moderator (ADR-0019) do not go through /join and change nothing here.
// Chat, presence and login stay multi-device.

// joinExclusive runs record — the caller's /join write — under the user's join lock and then
// takes the user's other devices out of voice. Under the lock two devices joining at once are
// ordered: the later one wins, they cannot take each other out.
func (s *Service) joinExclusive(ctx context.Context, uid, sid uuid.UUID, record func() error) error {
	return s.voice.WithUserLock(ctx, uid, func() error {
		if err := record(); err != nil {
			return err
		}
		if err := s.voice.ClearSuperseded(ctx, sid); err != nil {
			slog.WarnContext(ctx, "clear superseded voice device", "session", sid, "err", err)
		}
		s.takeOutOtherDevices(ctx, uid, sid)
		return nil
	})
}

// takeOutOtherDevices disconnects every voice device of uid other than keep. Best effort:
// the join that triggered it has already succeeded, a failure is logged (reconcile and the
// superseded mark keep a device that was not reached out of the call).
func (s *Service) takeOutOtherDevices(ctx context.Context, uid, keep uuid.UUID) {
	all, err := s.userSessions(ctx, uid)
	if err != nil {
		slog.WarnContext(ctx, "list sessions for one-device voice", "user", uid, "err", err)
		return
	}
	ids := make([]uuid.UUID, 0, len(all))
	for _, sid := range all {
		if sid != keep {
			ids = append(ids, sid)
		}
	}
	locs, err := s.voice.Locations(ctx, ids)
	if err != nil {
		slog.WarnContext(ctx, "voice locations for one-device voice", "user", uid, "err", err)
		return
	}
	for sid, loc := range locs {
		s.takeOutDevice(ctx, loc[0], loc[1], uid, sid)
	}
}

// userSessions lists the user's live auth sessions (devices); sessionsOf overrides it in tests.
func (s *Service) userSessions(ctx context.Context, uid uuid.UUID) ([]uuid.UUID, error) {
	if s.sessionsOf != nil {
		return s.sessionsOf(ctx, uid)
	}
	rows, err := s.db.Q.ListActiveSessions(ctx, uid)
	if err != nil {
		return nil, err
	}
	out := make([]uuid.UUID, len(rows))
	for i, r := range rows {
		out[i] = r.ID
	}
	return out, nil
}

// takeOutDevice disconnects one device of uid from room rid of scope wid for another device:
// the event first (the device then knows why LiveKit drops it), then LiveKit, then the state.
func (s *Service) takeOutDevice(ctx context.Context, wid, rid, uid, sid uuid.UUID) {
	slog.InfoContext(ctx, "voice device taken out: the user joined from another device", "user", uid, "session", sid, "room", rid)
	if err := s.voice.Supersede(ctx, sid, wid, rid); err != nil {
		slog.WarnContext(ctx, "mark superseded voice device", "session", sid, "err", err)
	}
	s.events.User(ctx, uid, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceDisconnected{VoiceDisconnected: &v1.VoiceDisconnected{
		WorkspaceId: scopeWS(wid, rid),
		RoomId:      rid.String(),
		SessionId:   sid.String(),
		Reason:      v1.VoiceDisconnectReason_VOICE_DISCONNECT_REASON_OTHER_DEVICE,
	}}})
	s.cancelConnect(sid)
	s.removeIdentities(ctx, voice.RoomName(wid, rid), []string{voice.Identity(uid, sid)})
	if err := s.update(ctx, wid, uid, sid, func(cur *voice.SessionState) *voice.SessionState {
		if cur == nil || cur.RoomID != rid {
			return cur // moved on meanwhile
		}
		return nil
	}); err != nil {
		slog.WarnContext(ctx, "clear voice state of a device taken out", "session", sid, "err", err)
	}
}

// superseded reports a device connecting to a room it was taken out of for another device
// (participant_joined, reconcile). A Redis error admits it (reconcile retries).
func (s *Service) superseded(ctx context.Context, wid, rid, sid uuid.UUID) bool {
	ok, err := s.voice.Superseded(ctx, sid, wid, rid)
	if err != nil {
		slog.WarnContext(ctx, "read superseded voice device", "session", sid, "err", err)
		return false
	}
	return ok
}
