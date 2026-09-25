// Package users serves the caller's own profile and settings (/api/me).
package users

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/profile"
	"github.com/calaba/calaba/server/internal/rooms"
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
		st := req.GetSettings()
		if st.AudioBitrateKbps != nil && !rooms.ValidAudioBitrate(st.GetAudioBitrateKbps()) {
			return httpx.Validation("settings.audioBitrateKbps", "audio bitrate must be one of 16, 24, 32, 48, 64")
		}
		b, err := pbconv.EncodeSettings(st)
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
	public := req.DisplayName != nil || req.StatusText != nil || req.AvatarFileId != nil
	profile.Publish(r.Context(), h.db.Q, h.events, u, public)
	httpx.Write(w, http.StatusOK, &v1.UpdateMeResponse{Me: pbconv.Me(u)})
	return nil
}
