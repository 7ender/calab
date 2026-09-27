// Package files implements uploads (streamed into blob.Store with sha256, size limit and
// workspace quota), thumbnails, authorized downloads and orphan cleanup (ADR-0011, docs/04).
package files

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"log/slog"
	"math"
	"mime"
	"mime/multipart"
	"net/http"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/profile"
	"github.com/calaba/calaba/server/internal/redisx"
)

// MaxAvatarBytes caps avatar uploads (they are user-scoped and not quota-counted).
const MaxAvatarBytes = 5 << 20

// uploadDeadline replaces the server's ReadTimeout for upload requests.
const uploadDeadline = 15 * time.Minute

// Service handles file storage.
type Service struct {
	db       *db.DB
	store    blob.Store
	events   events.Publisher
	maxBytes int64
	maxTotal int64               // server-wide cap on stored bytes (STORAGE_MAX_TOTAL_BYTES)
	limiter  *redisx.RateLimiter // uploads per user
	plans    *plans.Service      // workspace plan storage limit (ADR-0024); nil = none
}

// SetPlans sets the plan resolver (storage_mb caps the workspace quota).
func (s *Service) SetPlans(p *plans.Service) { s.plans = p }

// MaxUnattachedBytes caps what one user may keep uploaded-but-not-attached in a workspace,
// so that nobody (e.g. a guest) can occupy the quota with orphans until the 24 h cleanup.
const MaxUnattachedBytes = 1 << 30

// SetLimiter sets the per-user upload rate limiter.
func (s *Service) SetLimiter(l *redisx.RateLimiter) { s.limiter = l }

// NewService creates the files service; maxBytes is MAX_FILE_SIZE_MB in bytes, maxTotal the
// server-wide storage cap.
func NewService(d *db.DB, store blob.Store, ev events.Publisher, maxBytes, maxTotal int64) *Service {
	return &Service{db: d, store: store, events: ev, maxBytes: maxBytes, maxTotal: maxTotal}
}

var storageUsed = promauto.NewGauge(prometheus.GaugeOpts{
	Namespace: "calaba", Name: "storage_used_bytes", Help: "Bytes stored in files (all workspaces + avatars).",
})

var errStorageFull = httpx.Coded(http.StatusInsufficientStorage, v1.ErrorCode_ERROR_CODE_STORAGE_FULL, "server storage is full")

// checkTotal enforces the server-wide cap inside the upload transaction. The advisory lock
// serializes concurrent uploads between the check and their quota reservation.
func (s *Service) checkTotal(ctx context.Context, q *sqlc.Queries, size int64) error {
	if err := q.LockStorage(ctx); err != nil {
		return err
	}
	total, err := q.TotalStorageBytes(ctx)
	if err != nil {
		return err
	}
	storageUsed.Set(float64(total))
	if s.maxTotal > 0 && total+size > s.maxTotal {
		return errStorageFull
	}
	return nil
}

// RunStorageMetrics refreshes calaba_storage_used_bytes every interval.
func (s *Service) RunStorageMetrics(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if total, err := s.db.Q.TotalStorageBytes(ctx); err == nil {
			storageUsed.Set(float64(total))
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Routes registers authenticated routes; wrap must apply auth + perm resolver.
func (s *Service) Routes(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /api/workspaces/{id}/files", wrap(httpx.HandlerFunc(s.upload)))
	mux.Handle("POST /api/dms/{id}/files", wrap(httpx.HandlerFunc(s.uploadDM)))
	mux.Handle("POST /api/me/avatar", wrap(httpx.HandlerFunc(s.avatar)))
	mux.Handle("GET /api/files/{id}", wrap(httpx.HandlerFunc(s.download)))
	mux.Handle("GET /api/files/{id}/thumbnail", wrap(httpx.HandlerFunc(s.thumbnail)))
}

var (
	errTooLarge = errors.New("file too large")
	errQuota    = httpx.Coded(http.StatusRequestEntityTooLarge, v1.ErrorCode_ERROR_CODE_FILE_QUOTA_EXCEEDED, "workspace storage quota exceeded")
)

// quotaLimit is the effective storage quota of a workspace: its own storage_quota_bytes or
// the plan's storage_mb, whichever is lower (byPlan: the plan's is the binding one).
type quotaLimit struct {
	limit  int64
	byPlan bool
}

// err is 413 FILE_QUOTA_EXCEEDED with the usage and the quota (reason PLAN_LIMIT when the
// plan's limit is the binding one).
func (q quotaLimit) err(used int64) error {
	reason := ""
	if q.byPlan {
		reason = httpx.ReasonPlanLimit
	}
	return errQuota.WithDetails(reason, uint64(max(used, 0)), uint64(max(q.limit, 0)))
}

// quota returns the effective quota and the plan's limit for ReserveQuota (MaxInt64 = none).
func (s *Service) quota(ctx context.Context, ws sqlc.Workspace) (quotaLimit, int64, error) {
	q, planQuota := quotaLimit{limit: ws.StorageQuotaBytes}, int64(math.MaxInt64)
	if s.plans == nil {
		return q, planQuota, nil
	}
	l, err := s.plans.Effective(ctx, ws.ID)
	if err != nil {
		return q, planQuota, err
	}
	if b, ok := l.StorageBytes(); ok {
		planQuota = b
		if b < q.limit {
			q = quotaLimit{limit: b, byPlan: true}
		}
	}
	return q, planQuota, nil
}

func tooLarge(limit int64) error {
	return httpx.Coded(http.StatusRequestEntityTooLarge, v1.ErrorCode_ERROR_CODE_FILE_TOO_LARGE,
		fmt.Sprintf("file exceeds %d MB", limit>>20))
}

// limitHash counts and hashes bytes and fails once more than limit bytes were read.
type limitHash struct {
	r     io.Reader
	h     hash.Hash
	n     int64
	limit int64
}

func (l *limitHash) Read(p []byte) (int, error) {
	n, err := l.r.Read(p)
	l.n += int64(n)
	if l.n > l.limit {
		return 0, errTooLarge
	}
	l.h.Write(p[:n])
	return n, err
}

// DetectMime decides the stored type. Sniffing wins; the client-declared type is used only
// when sniffing is inconclusive and never to claim an image or active content.
func DetectMime(head []byte, declared string) string {
	sniffed, _, _ := mime.ParseMediaType(http.DetectContentType(head))
	if sniffed != "application/octet-stream" && sniffed != "text/plain" {
		return sniffed
	}
	d, _, err := mime.ParseMediaType(declared)
	if err != nil || d == "" {
		return sniffed
	}
	switch {
	case strings.HasPrefix(d, "image/"), strings.Contains(d, "html"), strings.Contains(d, "xml"),
		strings.Contains(d, "javascript"), strings.Contains(d, "ecmascript"):
		return sniffed
	}
	return d
}

// SanitizeName keeps a display-safe base file name (≤ 255 bytes).
func SanitizeName(name string) string {
	name = path.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == "/" {
		name = "file"
	}
	for len(name) > 255 {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	return name
}

// stored is a finished upload before it gets a DB row.
type stored struct {
	id         uuid.UUID
	key        string
	thumbKey   *string
	name, mime string
	size       int64
	sha256     string
	width      *int32
	height     *int32
}

// receive streams the "file" part of a multipart request into the store under
// keyFn(id) and makes a thumbnail for images. Blobs are removed on any error.
func (s *Service) receive(w http.ResponseWriter, r *http.Request, limit int64, keyFn func(uuid.UUID) string, imagesOnly bool) (*stored, error) {
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(uploadDeadline))
	r.Body = http.MaxBytesReader(w, r.Body, limit+1<<20) // multipart overhead
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, httpx.BadRequest("expected multipart/form-data with a \"file\" field")
	}
	var part *multipart.Part
	for i := 0; ; i++ {
		part, err = mr.NextPart()
		if err != nil || i > 8 {
			return nil, httpx.BadRequest("multipart field \"file\" not found")
		}
		if part.FormName() == "file" {
			break
		}
		_ = part.Close()
	}
	defer func() { _ = part.Close() }()

	br := bufio.NewReaderSize(part, 4096)
	head, _ := br.Peek(512)
	mt := DetectMime(head, part.Header.Get("Content-Type"))
	if imagesOnly && !pbconv.IsImage(mt) {
		return nil, httpx.Validation("file", "must be a JPEG, PNG, GIF or WebP image")
	}
	id, err := uuid.NewV7() // file ids are generated here: the blob key is needed before the row exists
	if err != nil {
		return nil, err
	}
	st := &stored{id: id, key: keyFn(id), name: SanitizeName(part.FileName()), mime: mt}
	lh := &limitHash{r: br, h: sha256.New(), limit: limit}
	if err := s.store.Put(r.Context(), st.key, lh, -1, mt); err != nil {
		var mbe *http.MaxBytesError
		if errors.Is(err, errTooLarge) || errors.As(err, &mbe) {
			return nil, tooLarge(limit)
		}
		return nil, fmt.Errorf("store upload: %w", err)
	}
	st.size, st.sha256 = lh.n, hex.EncodeToString(lh.h.Sum(nil))
	if pbconv.IsImage(mt) {
		s.makeThumbnail(r.Context(), st)
	}
	return st, nil
}

func (s *Service) makeThumbnail(ctx context.Context, st *stored) {
	open := func() (io.ReadCloser, error) {
		rc, _, err := s.store.Get(ctx, st.key)
		return rc, err
	}
	rc, err := open()
	if err != nil {
		return
	}
	cfg, err := ImageConfig(rc)
	_ = rc.Close()
	if err != nil {
		return
	}
	w, h := int32(min(cfg.Width, 1<<30)), int32(min(cfg.Height, 1<<30)) //nolint:gosec // clamped
	st.width, st.height = &w, &h
	thumb, err := Thumbnail(ctx, open)
	if err != nil {
		slog.InfoContext(ctx, "no thumbnail", "file_id", st.id, "err", err)
		return
	}
	key := st.key + ".thumb"
	if err := s.store.Put(ctx, key, bytes.NewReader(thumb), int64(len(thumb)), "image/webp"); err != nil {
		slog.WarnContext(ctx, "store thumbnail", "file_id", st.id, "err", err)
		return
	}
	st.thumbKey = &key
}

func (s *Service) discard(st *stored) {
	ctx := context.Background()
	_ = s.store.Delete(ctx, st.key)
	if st.thumbKey != nil {
		_ = s.store.Delete(ctx, *st.thumbKey)
	}
}

func (s *Service) upload(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	if _, _, err := perm.FromContext(r.Context()).Workspace(r.Context(), wsID, auth.MustFromContext(r.Context()).UserID); err != nil {
		if errors.Is(err, perm.ErrNotMember) {
			return httpx.NotFound("workspace")
		}
		return err
	}
	// Uploads are only useful to attach: require ATTACH_FILES in at least one room (it is
	// checked again per room when attaching).
	uid := auth.MustFromContext(r.Context()).UserID
	can, err := s.canAttachSomewhere(r.Context(), wsID, uid)
	if err != nil {
		return err
	}
	if !can {
		return httpx.Forbidden("ATTACH_FILES required")
	}
	if s.limiter != nil {
		if err := s.limiter.Take(r.Context(), uid.String()); err != nil {
			return err
		}
	}
	pending, err := s.db.Q.UnattachedBytesByUploader(r.Context(), sqlc.UnattachedBytesByUploaderParams{UploaderID: uid, WorkspaceID: &wsID})
	if err != nil {
		return err
	}
	if pending+max(r.ContentLength, 0) > MaxUnattachedBytes {
		return httpx.Coded(http.StatusRequestEntityTooLarge, v1.ErrorCode_ERROR_CODE_FILE_QUOTA_EXCEEDED,
			"too many uploaded files are not attached to messages yet")
	}
	ws, err := s.db.Q.GetWorkspace(r.Context(), wsID)
	if err != nil {
		return err
	}
	quota, planQuota, err := s.quota(r.Context(), ws)
	if err != nil {
		return err
	}
	if r.ContentLength > 0 && ws.StorageUsedBytes+r.ContentLength-(1<<20) > quota.limit {
		return quota.err(ws.StorageUsedBytes) // early reject from Content-Length before reading the body
	}
	st, err := s.receive(w, r, s.maxBytes, func(id uuid.UUID) string { return blob.FileKey(wsID, id) }, false)
	if err != nil {
		return err
	}
	var f sqlc.File
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := s.checkTotal(r.Context(), q, st.size); err != nil {
			return err
		}
		if _, err := q.ReserveQuota(r.Context(), sqlc.ReserveQuotaParams{ID: wsID, Size: st.size, PlanQuota: planQuota}); err != nil {
			if db.IsNotFound(err) {
				if cur, err := q.GetWorkspace(r.Context(), wsID); err == nil {
					return quota.err(cur.StorageUsedBytes)
				}
				return quota.err(ws.StorageUsedBytes)
			}
			return err
		}
		f, err = q.InsertFile(r.Context(), s.row(st, &wsID, auth.MustFromContext(r.Context()).UserID))
		return err
	})
	if err != nil {
		s.discard(st)
		return err
	}
	httpx.Write(w, http.StatusCreated, &v1.UploadFileResponse{File: pbconv.File(f)})
	return nil
}

// uploadDM: POST /api/dms/{id}/files — an attachment for a direct message (ADR-0020). DM
// files belong to no workspace: they are user-scoped (like avatars, but readable only
// through the DM once attached), count against the server-wide cap and the per-user limit of
// unattached bytes, not against any workspace quota.
func (s *Service) uploadDM(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	uid := auth.MustFromContext(r.Context()).UserID
	acc, err := perm.FromContext(r.Context()).Room(r.Context(), roomID, uid)
	if errors.Is(err, perm.ErrNoRoom) || (err == nil && !acc.DM) {
		return httpx.NotFound("room")
	}
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.AttachFiles) {
		return httpx.Forbidden("ATTACH_FILES required")
	}
	if s.limiter != nil {
		if err := s.limiter.Take(r.Context(), uid.String()); err != nil {
			return err
		}
	}
	pending, err := s.db.Q.UnattachedUserBytes(r.Context(), uid)
	if err != nil {
		return err
	}
	if pending+max(r.ContentLength, 0) > MaxUnattachedBytes {
		return httpx.Coded(http.StatusRequestEntityTooLarge, v1.ErrorCode_ERROR_CODE_FILE_QUOTA_EXCEEDED,
			"too many uploaded files are not attached to messages yet")
	}
	st, err := s.receive(w, r, s.maxBytes, func(id uuid.UUID) string { return "users/" + uid.String() + "/" + id.String() }, false)
	if err != nil {
		return err
	}
	var f sqlc.File
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := s.checkTotal(r.Context(), q, st.size); err != nil {
			return err
		}
		f, err = q.InsertFile(r.Context(), s.row(st, nil, uid))
		return err
	})
	if err != nil {
		s.discard(st)
		return err
	}
	httpx.Write(w, http.StatusCreated, &v1.UploadFileResponse{File: pbconv.File(f)})
	return nil
}

// canAttachSomewhere reports whether the user has ATTACH_FILES in any room of the workspace.
func (s *Service) canAttachSomewhere(ctx context.Context, wsID, uid uuid.UUID) (bool, error) {
	m, err := perm.FromContext(ctx).Member(ctx, wsID, uid)
	if err != nil {
		return false, err
	}
	if m.Workspace().Has(perm.AttachFiles) {
		return true, nil
	}
	rooms, err := s.db.Q.ListRooms(ctx, wsID)
	if err != nil {
		return false, err
	}
	ovs, err := s.db.Q.ListWorkspaceRoomOverrides(ctx, wsID)
	if err != nil {
		return false, err
	}
	byRoom := map[uuid.UUID][]sqlc.RoomPermission{}
	for _, o := range ovs {
		byRoom[o.RoomID] = append(byRoom[o.RoomID], o)
	}
	for _, room := range rooms {
		if perm.ComputeIn(m, pbconv.OverrideTargets(byRoom[room.ID])).Has(perm.ViewRoom | perm.AttachFiles) {
			return true, nil
		}
	}
	return false, nil
}

func (s *Service) row(st *stored, wsID *uuid.UUID, uploader uuid.UUID) sqlc.InsertFileParams {
	return sqlc.InsertFileParams{
		ID: st.id, WorkspaceID: wsID, UploaderID: uploader, Key: st.key, ThumbnailKey: st.thumbKey,
		Name: st.name, Mime: st.mime, Size: st.size, Width: st.width, Height: st.height, Sha256: st.sha256,
	}
}

func (s *Service) avatar(w http.ResponseWriter, r *http.Request) error {
	uid := auth.MustFromContext(r.Context()).UserID
	if u, err := s.db.Q.GetUser(r.Context(), uid); err != nil {
		return err
	} else if u.IsGuest {
		return httpx.Forbidden("not available for guest accounts")
	}
	st, err := s.receive(w, r, min(MaxAvatarBytes, s.maxBytes),
		func(id uuid.UUID) string { return "users/" + uid.String() + "/" + id.String() }, true)
	if err != nil {
		return err
	}
	var u sqlc.User
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := s.checkTotal(r.Context(), q, st.size); err != nil {
			return err
		}
		if _, err := q.InsertFile(r.Context(), s.row(st, nil, uid)); err != nil {
			return err
		}
		u, err = q.UpdateUser(r.Context(), sqlc.UpdateUserParams{ID: uid, SetAvatar: true, AvatarFileID: &st.id})
		return err
	})
	if err != nil {
		s.discard(st)
		return err
	}
	// The previous avatar is now unreferenced and is removed by the orphan cleanup.
	profile.Publish(r.Context(), s.db.Q, s.events, u, true)
	httpx.Write(w, http.StatusOK, &v1.UpdateMeResponse{Me: pbconv.Me(u)})
	return nil
}

// CanRead implements the download rule:
//   - the uploader;
//   - an avatar (user-scoped): any authenticated user;
//   - a workspace icon: members of the workspace;
//   - a file attached to a live message: VIEW_ROOM in that room.
func (s *Service) CanRead(r *http.Request, f sqlc.File) (bool, error) {
	ctx := r.Context()
	uid := auth.MustFromContext(ctx).UserID
	if f.UploaderID == uid {
		return true, nil
	}
	res := perm.FromContext(ctx)
	if f.WorkspaceID == nil {
		// User-scoped: an avatar is public; any other (a DM attachment, ADR-0020) follows the
		// room of its message like a workspace file.
		avatar, err := s.db.Q.IsAvatar(ctx, &f.ID)
		if err != nil || avatar {
			return avatar, err
		}
	} else {
		icon, err := s.db.Q.IsWorkspaceIcon(ctx, &f.ID)
		if err != nil {
			return false, err
		}
		if icon {
			_, err := res.Role(ctx, *f.WorkspaceID, uid)
			if errors.Is(err, perm.ErrNotMember) {
				return false, nil
			}
			return err == nil, err
		}
	}
	roomIDs, err := s.db.Q.FileRooms(ctx, f.ID)
	if err != nil {
		return false, err
	}
	for _, rid := range roomIDs {
		acc, err := res.Room(ctx, rid, uid)
		if errors.Is(err, perm.ErrNoRoom) {
			continue
		}
		if err != nil {
			return false, err
		}
		if acc.Bits.Has(perm.ViewRoom) {
			return true, nil
		}
	}
	return false, nil
}

func (s *Service) load(r *http.Request) (sqlc.File, error) {
	id, err := httpx.PathUUID(r, "id", "file")
	if err != nil {
		return sqlc.File{}, err
	}
	f, err := s.db.Q.GetFile(r.Context(), id)
	if db.IsNotFound(err) {
		return f, httpx.NotFound("file")
	}
	if err != nil {
		return f, err
	}
	ok, err := s.CanRead(r, f)
	if err != nil {
		return f, err
	}
	if !ok {
		return f, httpx.NotFound("file")
	}
	return f, nil
}

func (s *Service) serve(w http.ResponseWriter, r *http.Request, f sqlc.File, key, contentType, etag, name string) error {
	rc, _, err := s.store.Get(r.Context(), key)
	if errors.Is(err, blob.ErrNotFound) {
		return httpx.NotFound("file")
	}
	if err != nil {
		return err
	}
	defer func() { _ = rc.Close() }()
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("ETag", `"`+etag+`"`)
	h.Set("Cache-Control", "private, max-age=31536000, immutable") // content never changes for an id
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	disp := "attachment"
	if pbconv.IsImage(contentType) {
		disp = "inline"
	}
	h.Set("Content-Disposition", mime.FormatMediaType(disp, map[string]string{"filename": name}))
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(uploadDeadline))
	http.ServeContent(w, r, "", f.CreatedAt, rc) // Range, If-None-Match, If-Range
	return nil
}

func (s *Service) download(w http.ResponseWriter, r *http.Request) error {
	f, err := s.load(r)
	if err != nil {
		return err
	}
	return s.serve(w, r, f, f.Key, f.Mime, f.Sha256, f.Name)
}

func (s *Service) thumbnail(w http.ResponseWriter, r *http.Request) error {
	f, err := s.load(r)
	if err != nil {
		return err
	}
	if f.ThumbnailKey == nil {
		return httpx.NotFound("thumbnail")
	}
	name := strings.TrimSuffix(f.Name, path.Ext(f.Name)) + ".webp"
	return s.serve(w, r, f, *f.ThumbnailKey, "image/webp", f.Sha256+"-t", name)
}

// ValidateOwnImage checks that fileID is an image the user may use as an avatar
// (uploaded by them) or, with workspaceID set, as the icon of that workspace.
func ValidateOwnImage(ctx context.Context, q *sqlc.Queries, fileID, userID uuid.UUID, workspaceID *uuid.UUID) error {
	f, err := q.GetFile(ctx, fileID)
	if db.IsNotFound(err) {
		return errBadImage
	}
	if err != nil {
		return err
	}
	if !pbconv.IsImage(f.Mime) {
		return errBadImage
	}
	if workspaceID == nil {
		if f.UploaderID != userID {
			return errBadImage
		}
		return nil
	}
	if f.WorkspaceID == nil || *f.WorkspaceID != *workspaceID {
		return errBadImage
	}
	return nil
}

var errBadImage = errors.New("files: not a usable image")

// IsBadImage reports a ValidateOwnImage rejection.
func IsBadImage(err error) bool { return errors.Is(err, errBadImage) }

// DeleteBlobs removes stored objects (best effort, e.g. after a workspace was deleted).
func DeleteBlobs(ctx context.Context, store blob.Store, keys []sqlc.ListWorkspaceFileKeysRow) {
	for _, k := range keys {
		if err := store.Delete(ctx, k.Key); err != nil {
			slog.WarnContext(ctx, "delete blob", "key", k.Key, "err", err)
		}
		if k.ThumbnailKey != nil {
			_ = store.Delete(ctx, *k.ThumbnailKey)
		}
	}
}
