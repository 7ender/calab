package rtc

import (
	"net/http"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/voice"
)

// leave takes the caller's device out of a voice room at once (docs/05): «Отключиться», or a
// join cancelled before LiveKit connected. The device's state in the room — pending or
// connected — is removed and published (VOICE_STATE_UPDATE), its connect confirmation is
// disarmed, and its LiveKit participant, if any, is removed (participant_left then only
// cleans up tracks). Only the caller's own session is touched. Idempotent and room-scoped: a
// device recorded in another room (a newer /join) keeps that state, so a late leave cannot
// undo it. Always 204, also for an unknown room.
func (s *Service) leave(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	id := auth.MustFromContext(r.Context())
	identity := voice.Identity(id.UserID, id.SessionID)
	wid, rid, ok, err := s.voice.Location(r.Context(), id.SessionID)
	if err != nil {
		return err
	}
	if !ok || rid != roomID {
		// No state here (already gone, or recorded elsewhere): only a lingering LiveKit
		// connection of this device in the room may be left, e.g. a lost participant_joined
		// after the pending state was rolled back.
		room, err := s.getRoom(r.Context(), roomID)
		if err != nil {
			if db.IsNotFound(err) || httpx.AsError(err).Status == http.StatusNotFound {
				httpx.NoContent(w)
				return nil
			}
			return err
		}
		s.removeIdentities(r.Context(), voice.RoomName(room.WorkspaceID, roomID), []string{identity})
		httpx.NoContent(w)
		return nil
	}
	s.cancelConnect(id.SessionID)
	s.removeIdentities(r.Context(), voice.RoomName(wid, rid), []string{identity})
	if err := s.update(r.Context(), wid, id.UserID, id.SessionID, func(cur *voice.SessionState) *voice.SessionState {
		if cur == nil || cur.RoomID != roomID {
			return cur // joined elsewhere meanwhile
		}
		return nil
	}); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}
