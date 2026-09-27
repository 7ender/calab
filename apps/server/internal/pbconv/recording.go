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

// RecordingCard is the chat card of a recording. The audio's expiry (audio_until) and the
// normalized web_url are the recording service's (they depend on its configuration).
func RecordingCard(r sqlc.RoomRecording) *v1.SystemMessage {
	c := &v1.RecordingCard{
		RecordingId: r.ID.String(), StartedBy: idp(r.StartedBy), StartedAt: ts(r.StartedAt),
		DurationSec: uint32(max(r.DurationSec, 0)), Status: RecordingStatus(r.Status),
	}
	if r.DeletedAt != nil {
		c.DeletedAt, c.DeletedBy, c.FileGone, c.NotUploaded = ts(*r.DeletedAt), idp(r.DeletedBy), true, true
	} else {
		c.WebUrl, c.Error, c.FileGone, c.NotUploaded = r.WebUrl, r.Error, !RecordingHasFile(r), !RecordingUploaded(r)
		if r.Status == "done" {
			c.Summary, c.HasTranscript, c.ResultPending = r.Summary, r.TranscriptJson != nil, r.ResultState == "pending"
		}
	}
	return &v1.SystemMessage{Payload: &v1.SystemMessage_Recording{Recording: c}}
}

// RecordingHasFile reports whether the recording's local file should still be on the volume
// (the reupload endpoint checks the disk too).
func RecordingHasFile(r sqlc.RoomRecording) bool {
	return r.File != "" && r.FileDeletedAt == nil && r.SizeBytes > 0
}

// RecordingUploaded reports whether the recording reached GPTunneL's processing (its status
// can be polled again).
func RecordingUploaded(r sqlc.RoomRecording) bool {
	return r.GptunnelID != "" && r.ProcessingSince != nil
}
