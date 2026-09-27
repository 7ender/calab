package recording

import (
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"os"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
)

// Retry of a failed recording from its chat card (docs/09 backlog 40): «Проверить снова»
// polls GPTunneL's status again when the file was delivered (its processing failed on their
// side and may be fixed there); «Отправить снова» uploads the local file again when the upload
// did not complete, while the file is kept (7 days). A delivered file is never sent twice.

var errFileGone = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_FILE_GONE,
	"the recording's file is no longer kept on the server")

var errAlreadyUploaded = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_ALREADY_UPLOADED,
	"the recording was delivered to GPTunneL: check its status again instead")

// failedRecording checks the caller like start / stop and returns the recording {rid} of the
// room {id}, which must be FAILED; the workspace must be connected to GPTunneL.
func (s *Service) failedRecording(r *http.Request) (sqlc.RoomRecording, error) {
	room, acc, err := s.participant(r)
	if err != nil {
		return sqlc.RoomRecording{}, err
	}
	rid, err := httpx.PathUUID(r, "rid", "recording")
	if err != nil {
		return sqlc.RoomRecording{}, err
	}
	rec, err := s.db.Q.GetRecording(r.Context(), rid)
	if db.IsNotFound(err) || (err == nil && rec.RoomID != room.ID) {
		return rec, httpx.NotFound("recording")
	}
	if err != nil {
		return rec, err
	}
	if rec.Status != "failed" {
		return rec, httpx.Conflict("the recording has not failed")
	}
	if tok, _, err := s.deviceToken(r.Context(), acc.WorkspaceID); err != nil {
		return rec, err
	} else if tok == "" {
		return rec, errNotPaired
	}
	return rec, nil
}

// retried announces the new state on the card, wakes the worker and answers with the card.
func (s *Service) retried(w http.ResponseWriter, r *http.Request, upd sqlc.RoomRecording, what string) {
	slog.InfoContext(r.Context(), "recording: "+what, "recording", upd.ID, "by", uid(r))
	s.card(r.Context(), upd)
	s.Wake()
	httpx.Write(w, http.StatusOK, &v1.RetryRecordingResponse{Recording: s.cardOf(upd).GetRecording()})
}

func (s *Service) recheck(w http.ResponseWriter, r *http.Request) error {
	rec, err := s.failedRecording(r)
	if err != nil {
		return err
	}
	if !pbconv.RecordingUploaded(rec) {
		s.card(r.Context(), rec) // a card stored before not_uploaded existed offers recheck
		return httpx.Conflict("the recording never reached GPTunneL: send it again")
	}
	upd, err := s.db.Q.RecheckRecording(r.Context(), rec.ID)
	if db.IsNotFound(err) {
		return httpx.Conflict("the recording has changed meanwhile")
	}
	if err != nil {
		return err
	}
	s.retried(w, r, upd, "status check requested")
	return nil
}

func (s *Service) reupload(w http.ResponseWriter, r *http.Request) error {
	rec, err := s.failedRecording(r)
	if err != nil {
		return err
	}
	if pbconv.RecordingUploaded(rec) {
		// Delivered: GPTunneL has the file, sending it again would only duplicate it there.
		s.card(r.Context(), rec)
		return errAlreadyUploaded
	}
	if !pbconv.RecordingHasFile(rec) {
		s.card(r.Context(), rec)
		return errFileGone
	}
	if st, err := os.Stat(s.localPath(rec.File)); err != nil || !st.Mode().IsRegular() || st.Size() == 0 {
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		// Gone from the volume behind the database's back: remember it, the card hides the button.
		s.forgetFile(r.Context(), rec)
		return errFileGone
	}
	upd, err := s.db.Q.ReuploadRecording(r.Context(), rec.ID)
	if db.IsNotFound(err) {
		return httpx.Conflict("the recording has changed meanwhile")
	}
	if err != nil {
		return err
	}
	s.retried(w, r, upd, "upload requested again")
	return nil
}
