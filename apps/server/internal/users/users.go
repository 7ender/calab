// Package users serves the caller's own profile and settings (/api/me).
package users

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
)

// Handlers serves /api/me.
type Handlers struct {
	db     *db.DB
	events events.Publisher
}

// NewHandlers creates the /api/me handlers.
func NewHandlers(d *db.DB, ev events.Publisher) *Handlers { return &Handlers{db: d, events: ev} }

// Routes registers authenticated routes; wrap must apply auth.
func (h *Handlers) Routes(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/me", wrap(httpx.HandlerFunc(h.get)))
	mux.Handle("PATCH /api/me", wrap(httpx.HandlerFunc(h.update)))
}

func (h *Handlers) get(w http.ResponseWriter, r *http.Request) error {
	id := auth.MustFromContext(r.Context())
	u, err := h.db.Q.GetUser(r.Context(), id.UserID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.GetMeResponse{Me: pbconv.Me(u)})
	return nil
}

func (h *Handlers) update(w http.ResponseWriter, r *http.Request) error {
	id := auth.MustFromContext(r.Context())
	var req v1.UpdateMeRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	p := sqlc.UpdateUserParams{ID: id.UserID}
	if req.DisplayName != nil {
		name, err := auth.ValidateDisplayName(req.GetDisplayName())
		if err != nil {
			return err
		}
		p.DisplayName = &name
	}
	if req.StatusText != nil {
		st := strings.TrimSpace(req.GetStatusText())
		if utf8.RuneCountInString(st) > 128 {
			return httpx.Validation("statusText", "status text must be at most 128 characters")
		}
		p.StatusText = &st
	}
	if req.AvatarFileId != nil {
		p.SetAvatar = true
		if s := req.GetAvatarFileId(); s != "" {
			fid, err := uuid.Parse(s)
			if err != nil {
				return httpx.Validation("avatarFileId", "invalid file id")
			}
			if err := files.ValidateOwnImage(r.Context(), h.db.Q, fid, id.UserID, nil); err != nil {
				if files.IsBadImage(err) {
					return httpx.Validation("avatarFileId", "must be an image you uploaded")
				}
				return err
			}
			p.AvatarFileID = &fid
		}
	}
	if req.Settings != nil {
		b, err := protojson.Marshal(req.GetSettings())
		if err != nil {
			return err
		}
		p.Settings = b
	}
	u, err := h.db.Q.UpdateUser(r.Context(), p)
	if db.IsForeignKeyViolation(err) {
		return httpx.Validation("avatarFileId", "file not found")
	}
	if err != nil {
		return err
	}
	me := pbconv.Me(u)
	h.events.User(r.Context(), id.UserID, &v1.DispatchEvent{Event: &v1.DispatchEvent_UserUpdate{UserUpdate: &v1.UserUpdate{Me: me}}})
	httpx.Write(w, http.StatusOK, &v1.UpdateMeResponse{Me: me})
	return nil
}
