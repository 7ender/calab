package sso

import (
	"context"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// HTTPDeps keeps authentication, distributed quota and token/cookie delivery in root wiring.
// RateLimit must atomically enforce the supplied quota in Valkey and fail on dependency errors.
type HTTPDeps struct {
	Principal   func(*http.Request, bool) (identitypolicy.Principal, error)
	RateLimit   func(context.Context, string, int) (time.Duration, error)
	TrustedIP   func(*http.Request) string
	WriteResult func(http.ResponseWriter, *http.Request, Result)
	WriteError  func(http.ResponseWriter, *http.Request, error)
}

// HTTP exposes cohesive handlers; registering them does not bypass existing root middleware.
type HTTP struct {
	Service *Service
	Deps    HTTPDeps
}

// AuthorizeManagement applies the shared same-origin, session and distributed quota checks.
func (h *HTTP) AuthorizeManagement(w http.ResponseWriter, r *http.Request) (identitypolicy.Principal, bool) {
	return h.guard(w, r, false, "management", 30)
}

// Reject maps service errors through the application's established REST error writer.
func (h *HTTP) Reject(w http.ResponseWriter, r *http.Request, err error) { h.fail(w, r, err) }

// ReadRequest decodes a bounded generated protobuf JSON request.
func ReadRequest(r *http.Request, m proto.Message) error { return readProto(r, m) }

// WriteResponse serializes a generated response without exposing private service state.
func WriteResponse(w http.ResponseWriter, m proto.Message) { writeProto(w, m) }

// Registrar records routes in the application router.
type Registrar interface{ Handle(string, http.Handler) }

// Routes exports the frozen SSO paths through the application route recorder.
func (h *HTTP) Routes(mux Registrar) {
	mux.Handle("GET /api/auth/sso/workspaces/{slug}", http.HandlerFunc(h.descriptor))
	mux.Handle("POST /api/auth/sso/workspaces/{workspace_id}/begin", http.HandlerFunc(h.begin))
	mux.Handle("GET /api/auth/sso/browser-start", http.HandlerFunc(h.browserStart))
	mux.Handle("GET /api/auth/sso/callback/{connection_id}", http.HandlerFunc(h.callback))
	mux.Handle("POST /api/auth/sso/finish", http.HandlerFunc(h.finish))
	mux.Handle("POST /api/auth/sso/exchange", http.HandlerFunc(h.exchange))
	mux.Handle("GET /api/workspaces/{workspace_id}/identity", http.HandlerFunc(h.status))
	mux.Handle("PUT /api/workspaces/{workspace_id}/identity/connection", http.HandlerFunc(h.putConnection))
	mux.Handle("POST /api/workspaces/{workspace_id}/identity/test", http.HandlerFunc(h.test))
	mux.Handle("POST /api/workspaces/{workspace_id}/identity/connections/{connection_id}/activate", http.HandlerFunc(h.activate))
	mux.Handle("PUT /api/workspaces/{workspace_id}/identity/policy", http.HandlerFunc(h.policy))
	mux.Handle("POST /api/workspaces/{workspace_id}/identity/recovery-kit", http.HandlerFunc(h.recoveryKit))
	mux.Handle("POST /api/auth/sso/workspaces/{workspace_id}/recover", http.HandlerFunc(h.recover))
	mux.Handle("DELETE /api/workspaces/{workspace_id}/identity/link", http.HandlerFunc(h.unlink))
}
func headers(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}
func (h *HTTP) fail(w http.ResponseWriter, r *http.Request, e error) {
	headers(w)
	if h.Deps.WriteError != nil {
		h.Deps.WriteError(w, r, e)
		return
	}
	http.Error(w, "Identity request rejected", http.StatusForbidden)
}
func writeProto(w http.ResponseWriter, m proto.Message) {
	headers(w)
	b, e := protojson.Marshal(m)
	if e != nil {
		http.Error(w, "Identity dependency unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(b) //nolint:gosec // G705: protobuf JSON with application/json and nosniff, never HTML.
}
func readProto(r *http.Request, m proto.Message) error {
	if r.Header.Get("Content-Type") != "application/json" {
		return ErrInvalid
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, (64<<10)+1))
	if e != nil || len(b) > 64<<10 {
		return ErrInvalid
	}
	if protojson.Unmarshal(b, m) != nil {
		return ErrInvalid
	}
	return nil
}
func (h *HTTP) guard(w http.ResponseWriter, r *http.Request, optional bool, quota string, limit int) (identitypolicy.Principal, bool) {
	headers(w)
	if h == nil || h.Service == nil || h.Deps.Principal == nil || h.Deps.RateLimit == nil {
		h.fail(w, r, ErrDenied)
		return identitypolicy.Principal{}, false
	}
	if r.Method != "GET" && r.Header.Get("Origin") != h.Service.Protocol.Origin {
		h.fail(w, r, ErrDenied)
		return identitypolicy.Principal{}, false
	}
	p, e := h.Deps.Principal(r, optional)
	if e != nil {
		h.fail(w, r, e)
		return p, false
	}
	ip := ""
	if h.Deps.TrustedIP != nil {
		ip = h.Deps.TrustedIP(r)
	} else {
		ip, _, _ = net.SplitHostPort(r.RemoteAddr)
	}
	key := quota + ":ip:" + ip
	if quota == "management" {
		key = quota + ":user:" + p.UserID.String()
	}
	retry, e := h.Deps.RateLimit(r.Context(), key, limit)
	if e != nil {
		h.fail(w, r, e)
		return p, false
	}
	if retry > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(max(1, int(retry.Seconds()))))
		http.Error(w, "Identity rate limit exceeded", http.StatusTooManyRequests)
		return p, false
	}
	if quota == "begin" {
		retry, e = h.Deps.RateLimit(r.Context(), "begin:workspace:"+r.PathValue("workspace_id"), 10)
		if e != nil {
			h.fail(w, r, e)
			return p, false
		}
		if retry > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(max(1, int(retry.Seconds()))))
			http.Error(w, "Identity rate limit exceeded", http.StatusTooManyRequests)
			return p, false
		}
	}
	return p, true
}

// Pending SSO flows share one browser-binding cookie holding the browserCookieMax newest
// entries "<flow id>:<browser secret>", newest first (like the OAuth provider's request
// cookie). A cookie per flow would let a begin/browser-start loop fill the browser's
// per-site cookie jar and evict Calab session cookies.
const (
	browserCookieName = "__Host-calab-sso"
	browserCookieMax  = 4
)

type browserBinding struct {
	flow    uuid.UUID
	browser string
}

func browserSecretShape(v string) bool {
	if len(v) != 43 {
		return false
	}
	for _, c := range v {
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '-' && c != '_' {
			return false
		}
	}
	return true
}
func browserBindings(r *http.Request) []browserBinding {
	c, e := r.Cookie(browserCookieName)
	if e != nil {
		return nil
	}
	var out []browserBinding
	for _, entry := range strings.Split(c.Value, ".") {
		raw, browser, ok := strings.Cut(entry, ":")
		flow, e := uuid.Parse(raw)
		if !ok || e != nil || len(raw) != 36 || !browserSecretShape(browser) || len(out) == browserCookieMax {
			continue
		}
		out = append(out, browserBinding{flow: flow, browser: browser})
	}
	return out
}
func setBrowserBindings(w http.ResponseWriter, bindings []browserBinding) {
	if len(bindings) == 0 {
		http.SetCookie(w, &http.Cookie{Name: browserCookieName, Value: "", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, Path: "/", MaxAge: -1})
		return
	}
	entries := make([]string, 0, len(bindings))
	for _, b := range bindings {
		entries = append(entries, b.flow.String()+":"+b.browser)
	}
	http.SetCookie(w, &http.Cookie{Name: browserCookieName, Value: strings.Join(entries, "."), Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, Path: "/", MaxAge: 300})
}
func setBrowser(w http.ResponseWriter, r *http.Request, flow uuid.UUID, browser string) {
	bindings := []browserBinding{{flow: flow, browser: browser}}
	for _, b := range browserBindings(r) {
		if b.flow != flow {
			bindings = append(bindings, b)
		}
	}
	setBrowserBindings(w, bindings[:min(len(bindings), browserCookieMax)])
}
func dropBrowser(w http.ResponseWriter, r *http.Request, flow uuid.UUID) {
	var kept []browserBinding
	for _, b := range browserBindings(r) {
		if b.flow != flow {
			kept = append(kept, b)
		}
	}
	setBrowserBindings(w, kept)
}
func browserCookie(r *http.Request, flow uuid.UUID) string {
	for _, b := range browserBindings(r) {
		if b.flow == flow {
			return b.browser
		}
	}
	return ""
}
func workspaceID(r *http.Request) (uuid.UUID, error) {
	id, e := uuid.Parse(r.PathValue("workspace_id"))
	if e != nil || id == uuid.Nil {
		return uuid.Nil, ErrInvalid
	}
	return id, nil
}
func (h *HTTP) descriptor(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.guard(w, r, true, "begin", 10); !ok {
		return
	}
	ws, e := h.Service.DB.Q.GetSSOWorkspaceBySlug(r.Context(), r.PathValue("slug"))
	if e != nil {
		h.fail(w, r, ErrInvalid)
		return
	}
	out := &pb.PublicSSOWorkspace{WorkspaceId: ws.ID.String(), DisplayName: ws.Name}
	c, e := h.Service.DB.Q.GetActiveIdentityConnection(r.Context(), ws.ID)
	if e == nil && ws.SuspendedAt == nil && c.TestedVersion != nil && *c.TestedVersion == c.Version {
		if _, e = h.Service.grant(r.Context(), h.Service.DB.Q, ws.ID, identitypolicy.SSO); e == nil {
			out.LoginEnabled = true
			out.LoginLabel = c.Name
		}
	}
	writeProto(w, out)
}
func (h *HTTP) begin(w http.ResponseWriter, r *http.Request) { h.beginPurpose(w, r, false) }
func (h *HTTP) test(w http.ResponseWriter, r *http.Request)  { h.beginPurpose(w, r, true) }
func (h *HTTP) beginPurpose(w http.ResponseWriter, r *http.Request, test bool) {
	p, ok := h.guard(w, r, !test, "begin", 10)
	if !ok {
		return
	}
	ws, e := workspaceID(r)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	req := &pb.SSOBeginRequest{}
	if e = readProto(r, req); e != nil {
		h.fail(w, r, e)
		return
	}
	if test {
		req.Purpose = pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_TEST
	}
	out, e := h.Service.Begin(r.Context(), p, ws, req)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	if out.Browser != "" {
		flow, _ := uuid.Parse(out.Response.FlowId)
		setBrowser(w, r, flow, out.Browser)
	}
	writeProto(w, out.Response)
}
func (h *HTTP) browserStart(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.guard(w, r, true, "exchange", 30); !ok {
		return
	}
	handle := r.URL.Query().Get("handle")
	if len(handle) != 43 {
		h.fail(w, r, ErrInvalid)
		return
	}
	flow, browser, target, e := h.Service.BrowserStart(r.Context(), handle)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	setBrowser(w, r, flow, browser)
	http.Redirect(w, r, target, http.StatusSeeOther) //nolint:gosec // G710: encrypted, server-discovered operator-approved authorization URL or fixed completion target.
}
func (h *HTTP) callback(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.guard(w, r, true, "exchange", 30); !ok {
		return
	}
	connection, e := uuid.Parse(r.PathValue("connection_id"))
	q := r.URL.Query()
	if e != nil || len(q["state"]) != 1 || len(q["code"]) != 1 || q.Get("error") != "" || len(q.Get("state")) != 43 || len(q.Get("code")) > 4096 {
		h.fail(w, r, ErrInvalid)
		return
	}
	t, e := h.Service.DB.Q.GetIdentityLoginTransactionByState(r.Context(), identitycrypto.Hash(q.Get("state")))
	if e != nil {
		h.fail(w, r, ErrInvalid)
		return
	}
	out, e := h.Service.Callback(r.Context(), connection, q.Get("state"), browserCookie(r, t.ID), q.Get("code"))
	if e != nil {
		h.fail(w, r, e)
		return
	}
	target := "/sso/complete"
	if out.Native {
		target = "calab://sso/complete?flow=" + out.FlowID.String() + "&ticket=" + url.QueryEscape(out.Ticket)
	}
	http.Redirect(w, r, target, http.StatusSeeOther) //nolint:gosec // G710: encrypted, server-discovered operator-approved authorization URL or fixed completion target.
}
func (h *HTTP) deliver(w http.ResponseWriter, r *http.Request, out Result) {
	if h.Deps.WriteResult == nil {
		h.fail(w, r, ErrDenied)
		return
	}
	h.Deps.WriteResult(w, r, out)
}
func (h *HTTP) finish(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.guard(w, r, true, "exchange", 30); !ok {
		return
	}
	req := &pb.SSOFinishRequest{}
	if e := readProto(r, req); e != nil {
		h.fail(w, r, e)
		return
	}
	flow, e := uuid.Parse(req.FlowId)
	if e != nil {
		h.fail(w, r, ErrInvalid)
		return
	}
	if h.Deps.WriteResult == nil {
		h.fail(w, r, ErrDenied)
		return
	}
	out, e := h.Service.Finish(r.Context(), flow, browserCookie(r, flow))
	if e != nil {
		h.fail(w, r, e)
		return
	}
	dropBrowser(w, r, flow)
	h.deliver(w, r, out)
}
func (h *HTTP) exchange(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.guard(w, r, true, "exchange", 30); !ok {
		return
	}
	req := &pb.SSOExchangeRequest{}
	if e := readProto(r, req); e != nil {
		h.fail(w, r, e)
		return
	}
	flow, e := uuid.Parse(req.FlowId)
	if e != nil {
		h.fail(w, r, ErrInvalid)
		return
	}
	if h.Deps.WriteResult == nil {
		h.fail(w, r, ErrDenied)
		return
	}
	out, e := h.Service.Exchange(r.Context(), flow, req.Ticket, req.Verifier)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	h.deliver(w, r, out)
}
func (h *HTTP) status(w http.ResponseWriter, r *http.Request) {
	p, ok := h.guard(w, r, false, "management", 30)
	if !ok {
		return
	}
	ws, e := workspaceID(r)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	out, e := h.Service.Status(r.Context(), p, ws)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	writeProto(w, out)
}
func (h *HTTP) putConnection(w http.ResponseWriter, r *http.Request) {
	p, ok := h.guard(w, r, false, "management", 30)
	if !ok {
		return
	}
	ws, e := workspaceID(r)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	req := &pb.PutIdentityConnectionRequest{}
	if e = readProto(r, req); e != nil {
		h.fail(w, r, e)
		return
	}
	out, e := h.Service.PutConnection(r.Context(), p, ws, req)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	writeProto(w, out)
}
func (h *HTTP) activate(w http.ResponseWriter, r *http.Request) {
	p, ok := h.guard(w, r, false, "management", 30)
	if !ok {
		return
	}
	ws, e := workspaceID(r)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	id, e := uuid.Parse(r.PathValue("connection_id"))
	if e != nil {
		h.fail(w, r, ErrInvalid)
		return
	}
	req := &pb.ActivateIdentityConnectionRequest{}
	if e = readProto(r, req); e != nil {
		h.fail(w, r, e)
		return
	}
	if req.Version > math.MaxInt64 {
		h.fail(w, r, ErrInvalid)
		return
	}
	out, e := h.Service.ActivateConnection(r.Context(), p, ws, id, int64(req.Version))
	if e != nil {
		h.fail(w, r, e)
		return
	}
	writeProto(w, out)
}
func (h *HTTP) policy(w http.ResponseWriter, r *http.Request) {
	p, ok := h.guard(w, r, false, "management", 30)
	if !ok {
		return
	}
	ws, e := workspaceID(r)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	req := &pb.PutIdentityPolicyRequest{}
	if e = readProto(r, req); e == nil {
		e = h.Service.SetPolicy(r.Context(), p, ws, req)
	}
	if e != nil {
		h.fail(w, r, e)
		return
	}
	w.WriteHeader(204)
}
func (h *HTTP) recoveryKit(w http.ResponseWriter, r *http.Request) {
	p, ok := h.guard(w, r, false, "management", 30)
	if !ok {
		return
	}
	ws, e := workspaceID(r)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	out, e := h.Service.RecoveryKit(r.Context(), p, ws)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	writeProto(w, out)
}
func (h *HTTP) recover(w http.ResponseWriter, r *http.Request) {
	p, ok := h.guard(w, r, false, "management", 30)
	if !ok {
		return
	}
	ws, e := workspaceID(r)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	req := &pb.IdentityRecoverRequest{}
	if e = readProto(r, req); e != nil {
		h.fail(w, r, e)
		return
	}
	if h.Deps.WriteResult == nil {
		h.fail(w, r, ErrDenied)
		return
	}
	out, e := h.Service.Recover(r.Context(), p, ws, req.RecoveryCode)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	h.deliver(w, r, Result{Tokens: out})
}
func (h *HTTP) unlink(w http.ResponseWriter, r *http.Request) {
	p, ok := h.guard(w, r, false, "management", 30)
	if !ok {
		return
	}
	ws, e := workspaceID(r)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	if e = h.Service.Unlink(r.Context(), p, ws); e != nil {
		h.fail(w, r, e)
		return
	}
	w.WriteHeader(204)
}
