package pbconv

import (
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// RecordingActive reports whether a recording row shows as "REC" (ADR-0025): it runs and
// nobody asked it to stop yet (a stopped recording stays 'recording' until the recorder
// hands over the file).
func RecordingActive(r sqlc.RoomRecording) bool {
	return (r.Status == "pending" || r.Status == "recording") && r.StoppedAt == nil
}

// RoomRecording converts a recording row to its indicator state.
func RoomRecording(r sqlc.RoomRecording) *v1.RoomRecording {
	out := &v1.RoomRecording{
		WorkspaceId: r.WorkspaceID.String(), RoomId: r.RoomID.String(), RecordingId: r.ID.String(),
		State: v1.RoomRecordingState_ROOM_RECORDING_STATE_STOPPED, ByUserId: idp(r.StartedBy), Since: ts(r.StartedAt),
	}
	if RecordingActive(r) {
		out.State = v1.RoomRecordingState_ROOM_RECORDING_STATE_ACTIVE
	} else {
		out.StopReason, out.StoppedBy = r.StopReason, idp(r.StoppedBy)
	}
	return out
}

// RecordingStatus maps room_recordings.status to the card status.
func RecordingStatus(status string) v1.RecordingStatus {
	switch status {
	case "pending", "recording":
		return v1.RecordingStatus_RECORDING_STATUS_RECORDING
	case "uploading":
		return v1.RecordingStatus_RECORDING_STATUS_UPLOADING
	case "processing":
		return v1.RecordingStatus_RECORDING_STATUS_PROCESSING
	case "done":
		return v1.RecordingStatus_RECORDING_STATUS_DONE
	case "failed":
		return v1.RecordingStatus_RECORDING_STATUS_FAILED
	}
	return v1.RecordingStatus_RECORDING_STATUS_UNSPECIFIED
}

// RecordingCard is the chat card of a recording.
func RecordingCard(r sqlc.RoomRecording) *v1.SystemMessage {
	return &v1.SystemMessage{Payload: &v1.SystemMessage_Recording{Recording: &v1.RecordingCard{
		RecordingId: r.ID.String(), StartedBy: idp(r.StartedBy), StartedAt: ts(r.StartedAt),
		DurationSec: uint32(max(r.DurationSec, 0)), Status: RecordingStatus(r.Status), WebUrl: r.WebUrl, Error: r.Error,
	}}}
}
