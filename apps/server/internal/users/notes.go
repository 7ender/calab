package users

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// MaxNoteLength is the limit of a private note, in characters (user_notes CHECK).
const MaxNoteLength = 1000

// noteSubject resolves {id} of /api/users/{id}/note: the subject must be the caller or share a
// workspace or a DM with them, otherwise 404 (no hint whether the user exists).
func (h *Handlers) noteSubject(r *http.Request) (author, subject uuid.UUID, err error) {
	author = auth.MustFromContext(r.Context()).UserID
	subject, err = uuid.Parse(r.PathValue("id"))
	if err != nil {
		return author, subject, httpx.NotFound("user")
	}
	ok, err := h.db.Q.CanSeeUser(r.Context(), sqlc.CanSeeUserParams{UserID: author, SubjectID: subject})
	if err != nil {
		return author, subject, err
	}
	if !ok {
		return author, subject, httpx.NotFound("user")
	}
	return author, subject, nil
}

func noteResponse(subject uuid.UUID, n *sqlc.UserNote) *v1.UserNoteResponse {
	out := &v1.UserNote{SubjectId: subject.String()}
	if n != nil {
		out.Text = n.Text
		out.UpdatedAt = timestamppb.New(n.UpdatedAt)
	}
	return &v1.UserNoteResponse{Note: out}
}

// getNote: GET /api/users/{id}/note — the caller's own note (empty = none).
func (h *Handlers) getNote(w http.ResponseWriter, r *http.Request) error {
	author, subject, err := h.noteSubject(r)
	if err != nil {
		return err
	}
	n, err := h.db.Q.GetUserNote(r.Context(), sqlc.GetUserNoteParams{AuthorID: author, SubjectID: subject})
	if db.IsNotFound(err) {
		httpx.Write(w, http.StatusOK, noteResponse(subject, nil))
		return nil
	}
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, noteResponse(subject, &n))
	return nil
}

// putNote: PUT /api/users/{id}/note {text} — sets the note; empty text deletes it.
func (h *Handlers) putNote(w http.ResponseWriter, r *http.Request) error {
	author, subject, err := h.noteSubject(r)
	if err != nil {
		return err
	}
	var req v1.PutUserNoteRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	text := strings.TrimSpace(req.GetText())
	if utf8.RuneCountInString(text) > MaxNoteLength {
		return httpx.Validation("text", "note must be at most 1000 characters")
	}
	if text == "" {
		if err := h.db.Q.DeleteUserNote(r.Context(), sqlc.DeleteUserNoteParams{AuthorID: author, SubjectID: subject}); err != nil {
			return err
		}
		httpx.Write(w, http.StatusOK, noteResponse(subject, nil))
		return nil
	}
	n, err := h.db.Q.UpsertUserNote(r.Context(), sqlc.UpsertUserNoteParams{AuthorID: author, SubjectID: subject, Text: text})
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, noteResponse(subject, &n))
	return nil
}

// deleteNote: DELETE /api/users/{id}/note → 204 (also when there was none).
func (h *Handlers) deleteNote(w http.ResponseWriter, r *http.Request) error {
	author, subject, err := h.noteSubject(r)
	if err != nil {
		return err
	}
	if err := h.db.Q.DeleteUserNote(r.Context(), sqlc.DeleteUserNoteParams{AuthorID: author, SubjectID: subject}); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}
