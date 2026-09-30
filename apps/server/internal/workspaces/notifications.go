package workspaces

import (
	"net/http"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/notifications"
	"github.com/calaba/calaba/server/internal/pbconv"
)

// setNotifications: PUT /api/workspaces/{id}/notifications (any member, guests included).
// Replaces the caller's settings for the workspace; the default (MENTIONS, not muted) is
// stored as no row. The caller's devices get WORKSPACE_NOTIFICATION_UPDATE.
func (h *Handlers) setNotifications(w http.ResponseWriter, r *http.Request) error {
	wsID, _, _, err := access(r)
	if err != nil {
		return err
	}
	var req v1.UpdateWorkspaceNotificationSettingsRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	level, ok := notifications.WorkspaceLevelToDB(req.GetLevel())
	if !ok {
		return httpx.Validation("level", "unknown notification level")
	}
	until, err := notifications.ParseMute(req.MutedUntil, time.Now())
	if err != nil {
		return httpx.Validation("mutedUntil", err.Error())
	}
	userID := uid(r)
	// «Задачи» (ADR-0042): unset keeps the stored level; the default ALL needs no row.
	taskLevel, err := h.db.Q.GetWorkspaceTaskLevel(r.Context(), sqlc.GetWorkspaceTaskLevelParams{UserID: userID, WorkspaceID: wsID})
	if err != nil {
		return err
	}
	if req.TaskLevel != nil {
		tl, ok := notifications.TaskLevelToDB(req.GetTaskLevel())
		if !ok {
			return httpx.Validation("taskLevel", "task level must be ALL, MENTIONS or NONE")
		}
		taskLevel = tl
	}
	out := &v1.WorkspaceNotificationSettings{WorkspaceId: wsID.String(), Level: v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS,
		TaskLevel: v1.NotificationLevel_NOTIFICATION_LEVEL_ALL}
	if level == notifications.DBMentions && until == nil && taskLevel == notifications.DBAll {
		if err := h.db.Q.DeleteWorkspaceNotificationSettings(r.Context(), sqlc.DeleteWorkspaceNotificationSettingsParams{UserID: userID, WorkspaceID: wsID}); err != nil {
			return err
		}
	} else {
		row, err := h.db.Q.UpsertWorkspaceNotificationSettings(r.Context(), sqlc.UpsertWorkspaceNotificationSettingsParams{
			UserID: userID, WorkspaceID: wsID, Level: level, MutedUntil: until, TaskLevel: taskLevel,
		})
		if err != nil {
			return err
		}
		out = pbconv.WorkspaceNotificationSettings(row)
	}
	h.events.User(r.Context(), userID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceNotificationUpdate{
		WorkspaceNotificationUpdate: &v1.WorkspaceNotificationUpdate{Settings: out},
	}})
	httpx.Write(w, http.StatusOK, &v1.UpdateWorkspaceNotificationSettingsResponse{Settings: out})
	return nil
}
