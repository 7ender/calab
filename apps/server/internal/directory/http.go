package directory

import (
	"net/http"
	"strconv"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/sso"
	"github.com/google/uuid"
)

// HTTP uses the same root-authenticated principal and Valkey quota hooks as SSO.
type HTTP struct {
	Service *Service
	Gate    *sso.HTTP
}

// Routes registers all directory handlers through the root route recorder.
func (h *HTTP) Routes(r sso.Registrar) {
	r.Handle("GET /api/workspaces/{workspace_id}/identity/directory", http.HandlerFunc(h.get))
	r.Handle("PUT /api/workspaces/{workspace_id}/identity/directory", http.HandlerFunc(h.put))
	r.Handle("POST /api/workspaces/{workspace_id}/identity/directory/test", http.HandlerFunc(h.test))
	r.Handle("POST /api/workspaces/{workspace_id}/identity/directory/sync", http.HandlerFunc(h.sync))
	r.Handle("GET /api/workspaces/{workspace_id}/identity/directory/members", http.HandlerFunc(h.members))
	r.Handle("PUT /api/workspaces/{workspace_id}/identity/directory/members/{user_id}", http.HandlerFunc(h.link))
}
func workspace(r *http.Request) (uuid.UUID, error) {
	id, err := uuid.Parse(r.PathValue("workspace_id"))
	if err != nil || id == uuid.Nil {
		return uuid.Nil, sso.ErrInvalid
	}
	return id, nil
}
func (h *HTTP) get(w http.ResponseWriter, r *http.Request) {
	p, ok := h.Gate.AuthorizeManagement(w, r)
	if !ok {
		return
	}
	ws, err := workspace(r)
	if err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	out, err := h.Service.Get(r.Context(), p, ws)
	if err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	sso.WriteResponse(w, out)
}
func (h *HTTP) put(w http.ResponseWriter, r *http.Request) {
	p, ok := h.Gate.AuthorizeManagement(w, r)
	if !ok {
		return
	}
	ws, err := workspace(r)
	if err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	req := &pb.PutIdentityDirectoryRequest{}
	if err = sso.ReadRequest(r, req); err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	out, err := h.Service.Put(r.Context(), p, ws, req)
	if err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	sso.WriteResponse(w, out)
}
func (h *HTTP) test(w http.ResponseWriter, r *http.Request) {
	p, ok := h.Gate.AuthorizeManagement(w, r)
	if !ok {
		return
	}
	ws, err := workspace(r)
	if err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	if err = h.Service.Test(r.Context(), p, ws); err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	w.WriteHeader(204)
}
func (h *HTTP) sync(w http.ResponseWriter, r *http.Request) {
	p, ok := h.Gate.AuthorizeManagement(w, r)
	if !ok {
		return
	}
	ws, err := workspace(r)
	if err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	retry, err := h.Gate.Deps.RateLimit(r.Context(), "directory-sync:"+ws.String(), 1)
	if err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	if retry > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(max(1, int(retry.Seconds()))))
		http.Error(w, "Directory rate limit exceeded", 429)
		return
	}
	if err = h.Service.Identity.DB.Tx(r.Context(), func(q *sqlc.Queries) error { return h.Service.authorize(r.Context(), q, p, ws) }); err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	if err = h.Service.Sync(r.Context(), ws); err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	w.WriteHeader(204)
}
func (h *HTTP) members(w http.ResponseWriter, r *http.Request) {
	p, ok := h.Gate.AuthorizeManagement(w, r)
	if !ok {
		return
	}
	ws, err := workspace(r)
	if err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	var after *uuid.UUID
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			h.Gate.Reject(w, r, sso.ErrInvalid)
			return
		}
		after = &id
	}
	out, err := h.Service.Members(r.Context(), p, ws, after)
	if err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	sso.WriteResponse(w, out)
}
func (h *HTTP) link(w http.ResponseWriter, r *http.Request) {
	p, ok := h.Gate.AuthorizeManagement(w, r)
	if !ok {
		return
	}
	ws, err := workspace(r)
	if err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	user, err := uuid.Parse(r.PathValue("user_id"))
	if err != nil {
		h.Gate.Reject(w, r, sso.ErrInvalid)
		return
	}
	req := &pb.PutIdentityDirectoryMemberRequest{}
	if err = sso.ReadRequest(r, req); err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	guid, err := uuid.Parse(req.ObjectGuid)
	if err != nil {
		h.Gate.Reject(w, r, sso.ErrInvalid)
		return
	}
	if err = h.Service.Link(r.Context(), p, ws, user, guid); err != nil {
		h.Gate.Reject(w, r, err)
		return
	}
	w.WriteHeader(204)
}
