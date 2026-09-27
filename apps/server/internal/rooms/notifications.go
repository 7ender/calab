package rooms

import (
	"net/http"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/notifications"
	"github.com/calaba/calaba/server/internal/pbconv"
)

// setNotifications: PUT /api/rooms/{id}/notifications (VIEW_ROOM). Replaces the caller's
// settings; the default (INHERIT, not muted) is stored as no row. The caller's devices get
// ROOM_NOTIFICATION_UPDATE.
func (h *Handlers) setNotifications(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	if _, err := roomAccess(r, roomID); err != nil {
		return err
	}
	var req v1.UpdateRoomNotificationSettingsRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	level, ok := notifications.RoomLevelToDB(req.GetLevel())
	if !ok {
		return httpx.Validation("level", "unknown notification level")
	}
	until, err := notifications.ParseMute(req.MutedUntil, time.Now())
	if err != nil {
		return httpx.Validation("mutedUntil", err.Error())
	}
	userID := auth.MustFromContext(r.Context()).UserID
	out := &v1.RoomNotificationSettings{RoomId: roomID.String(), Level: v1.NotificationLevel_NOTIFICATION_LEVEL_INHERIT}
	if level == notifications.DBInherit && until == nil {
		if err := h.db.Q.DeleteRoomNotificationSettings(r.Context(), sqlc.DeleteRoomNotificationSettingsParams{UserID: userID, RoomID: roomID}); err != nil {
			return err
		}
	} else {
		row, err := h.db.Q.UpsertRoomNotificationSettings(r.Context(), sqlc.UpsertRoomNotificationSettingsParams{
			UserID: userID, RoomID: roomID, Level: level, MutedUntil: until,
		})
		if err != nil {
			return err
		}
		out = pbconv.RoomNotificationSettings(row)
	}
	h.events.User(r.Context(), userID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomNotificationUpdate{
		RoomNotificationUpdate: &v1.RoomNotificationUpdate{Settings: out},
	}})
	httpx.Write(w, http.StatusOK, &v1.UpdateRoomNotificationSettingsResponse{Settings: out})
	return nil
}
