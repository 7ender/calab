// Package gptunnel is a client of GPTunneL's meeting-recording device API
// (`/v1/meetings/device/*`, ADR-0025): pair a device with a one-time code, upload a recording
// in resumable chunks and read its processing status. The contract is the one of
// gptunnel-recorder (packages/shared/types/meetings.d.ts): Bearer device token, JSON errors
// `{error, message}`, chunks with Content-Range and the accepted offset in Upload-Offset.
package gptunnel

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Recording statuses in GPTunneL.
const (
	StatusUploading    = "uploading"
	StatusUploaded     = "uploaded"
	StatusTranscribing = "transcribing"
	StatusSummarizing  = "summarizing"
	StatusDone         = "done"
	StatusFailed       = "failed"
	StatusCancelled    = "cancelled"
)

// Error codes of the device API (and ours: network, http, server_unsupported).
const (
	CodeInvalidCode         = "invalid_code"
	CodeTooManyAttempts     = "too_many_attempts"
	CodeUnauthorized        = "unauthorized"
	CodeDeviceRevoked       = "device_revoked"
	CodeNotFound            = "not_found"
	CodeOffsetMismatch      = "offset_mismatch"
	CodeTooLarge            = "too_large"
	CodeIncomplete          = "incomplete"
	CodeInsufficientBalance = "insufficient_balance"
	CodeTooManyUploads      = "too_many_uploads"
	CodeInternal            = "internal" // a recording's status error: GPTunneL's own fault
	CodeNetwork             = "network"
	CodeHTTP                = "http"
	CodeServerUnsupported   = "server_unsupported"
)

// DefaultChunkSize is the upload chunk (as gptunnel-recorder).
const DefaultChunkSize = 8 << 20

// Limits of one recording in GPTunneL (ADR-0025): larger or longer ones are rejected.
const (
	MaxBytes    = 4 << 30
	MaxDuration = 4 * time.Hour
)

// Error is a failed call. Status 0 = no HTTP answer (network).
type Error struct {
	Status     int
	Code       string
	Message    string
	Offset     int64         // Upload-Offset of the answer, -1 if absent
	RetryAfter time.Duration // Retry-After of the answer, 0 if absent
}

func (e *Error) Error() string {
	return fmt.Sprintf("gptunnel: %d %s: %s", e.Status, e.Code, e.Message)
}

// Retryable reports errors worth repeating (network, 5xx, 408, 429 — except
// too_many_uploads, which waits for other uploads to finish).
func (e *Error) Retryable() bool {
	if e.Code == CodeTooManyUploads {
		return false
	}
	return e.Code == CodeNetwork || e.Status >= 500 || e.Status == http.StatusRequestTimeout || e.Status == http.StatusTooManyRequests
}

// Unauthorized reports a device token that no longer works (401: revoked / unknown).
func (e *Error) Unauthorized() bool { return e.Status == http.StatusUnauthorized }

// AsError extracts an *Error.
func AsError(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}

// Device is a paired device.
type Device struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Account is the GPTunneL user a device belongs to.
type Account struct {
	ID    string  `json:"id"`
	Name  *string `json:"name"`
	Email *string `json:"email"`
}

// Label is a human name of the account: name, else email.
func (a Account) Label() string {
	if a.Name != nil && *a.Name != "" {
		return *a.Name
	}
	if a.Email != nil {
		return *a.Email
	}
	return ""
}

// Session is the answer of pair and me. Token is only in the pair answer.
type Session struct {
	Token  string  `json:"token,omitempty"`
	Device Device  `json:"device"`
	User   Account `json:"user"`
	WebURL string  `json:"web_url"`
}

// PairRequest is the body of POST /pair.
type PairRequest struct {
	Code       string `json:"code"`
	Name       string `json:"name"`
	Platform   string `json:"platform"`
	AppVersion string `json:"app_version"`
}

// CreateRequest is the body of POST /recordings. A repeated create with the same ClientID
// returns the same recording.
type CreateRequest struct {
	ClientID    string `json:"client_id"`
	Title       string `json:"title"`
	Kind        string `json:"kind"` // "video" for MP4
	Mime        string `json:"mime"` // "video/mp4"
	SizeBytes   int64  `json:"size_bytes"`
	DurationSec int64  `json:"duration_sec"`
	StartedAt   string `json:"started_at"` // RFC 3339
}

// RecordingStatus is GET /recordings/:id and the answer of complete.
type RecordingStatus struct {
	ID     string  `json:"id"`
	Status string  `json:"status"`
	Error  *string `json:"error"`
	Offset int64   `json:"offset"`
	WebURL string  `json:"web_url"`
}

// ErrorCode is the failure reason ("" if none).
func (r *RecordingStatus) ErrorCode() string {
	if r.Error == nil {
		return ""
	}
	return *r.Error
}

// Client calls the device API at BaseURL (GPTUNNEL_API_URL).
type Client struct {
	base string
	hc   *http.Client
	// Tunables (tests shorten them).
	ChunkSize   int64
	CallTimeout time.Duration // JSON calls
	PutTimeout  time.Duration // one chunk
	MaxRetries  int           // consecutive retryable failures within one Upload
	Backoff     func(attempt int) time.Duration
}

// New creates a client for baseURL (e.g. https://gptunnel.ai).
func New(baseURL string) *Client {
	return &Client{
		base:      strings.TrimRight(baseURL, "/") + "/v1/meetings/device",
		hc:        &http.Client{}, // deadlines come from contexts: chunks may take minutes
		ChunkSize: DefaultChunkSize, CallTimeout: 30 * time.Second, PutTimeout: 5 * time.Minute, MaxRetries: 5,
		Backoff: func(attempt int) time.Duration { return min(time.Second<<max(attempt-1, 0), 30*time.Second) },
	}
}

type call struct {
	method, path, token string
	json                any
	body                []byte
	headers             map[string]string
	allow               []int // statuses that are not errors (409 of PUT / HEAD)
	timeout             time.Duration
}

// answer is a successful (or allowed) response, its body already read and closed.
type answer struct {
	status int
	offset int64 // Upload-Offset, -1 if absent
}

// do performs one call.
func (c *Client) do(ctx context.Context, cl call) (answer, []byte, error) {
	timeout := cl.timeout
	if timeout <= 0 {
		timeout = c.CallTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var body io.Reader
	var ctype string
	switch {
	case cl.json != nil:
		b, err := json.Marshal(cl.json)
		if err != nil {
			return answer{}, nil, err
		}
		body, ctype = bytes.NewReader(b), "application/json"
	case cl.body != nil:
		body, ctype = bytes.NewReader(cl.body), "application/octet-stream"
	}
	// URL = GPTUNNEL_API_URL (operator config) + constant paths with escaped ids.
	req, err := http.NewRequestWithContext(ctx, cl.method, c.base+cl.path, body) //nolint:gosec // G704, see above
	if err != nil {
		return answer{}, nil, err
	}
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	req.Header.Set("Accept", "application/json")
	if cl.token != "" {
		req.Header.Set("Authorization", "Bearer "+cl.token)
	}
	for k, v := range cl.headers {
		req.Header.Set(k, v)
	}
	resp, err := c.hc.Do(req) //nolint:gosec // G704: operator-configured URL
	if err != nil {
		if ctx.Err() != nil && errors.Is(ctx.Err(), context.Canceled) {
			return answer{}, nil, ctx.Err()
		}
		return answer{}, nil, &Error{Code: CodeNetwork, Message: err.Error(), Offset: -1}
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return answer{}, nil, &Error{Status: resp.StatusCode, Code: CodeNetwork, Message: err.Error(), Offset: -1}
	}
	ans := answer{status: resp.StatusCode, offset: headerOffset(resp)}
	if resp.StatusCode < 300 {
		return ans, raw, nil
	}
	for _, a := range cl.allow {
		if resp.StatusCode == a {
			return ans, raw, nil
		}
	}
	e := &Error{Status: resp.StatusCode, Code: CodeHTTP, Message: "HTTP " + strconv.Itoa(resp.StatusCode),
		Offset: ans.offset, RetryAfter: retryAfter(resp.Header.Get("Retry-After"))}
	var eb struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	ours := json.Unmarshal(raw, &eb) == nil && eb.Error != ""
	if ours {
		e.Code = eb.Error
		if eb.Message != "" {
			e.Message = eb.Message
		}
	} else if cl.method == http.MethodHead && resp.StatusCode == http.StatusNotFound {
		e.Code = CodeNotFound // HEAD answers have no body
	} else if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusMethodNotAllowed || resp.StatusCode == http.StatusNotImplemented {
		e.Code = CodeServerUnsupported // not GPTunneL's device API at this address
	}
	return answer{}, nil, e
}

func headerOffset(resp *http.Response) int64 {
	h := resp.Header.Get("Upload-Offset")
	if h == "" {
		return -1
	}
	n, err := strconv.ParseInt(h, 10, 64)
	if err != nil || n < 0 {
		return -1
	}
	return n
}

func retryAfter(h string) time.Duration {
	if h == "" {
		return 0
	}
	if s, err := strconv.Atoi(h); err == nil {
		return time.Duration(max(s, 0)) * time.Second
	}
	if t, err := http.ParseTime(h); err == nil {
		return max(time.Until(t), 0)
	}
	return 0
}

func (c *Client) jsonCall(ctx context.Context, cl call, out any) error {
	_, raw, err := c.do(ctx, cl)
	if err != nil {
		return err
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return &Error{Status: http.StatusOK, Code: CodeHTTP, Message: "bad JSON answer: " + err.Error(), Offset: -1}
		}
	}
	return nil
}

// Pair exchanges a one-time code for a device token.
func (c *Client) Pair(ctx context.Context, req PairRequest) (*Session, error) {
	var s Session
	if err := c.jsonCall(ctx, call{method: http.MethodPost, path: "/pair", json: req}, &s); err != nil {
		return nil, err
	}
	if s.Token == "" {
		return nil, &Error{Status: http.StatusOK, Code: CodeHTTP, Message: "pair answer without a token", Offset: -1}
	}
	return &s, nil
}

// Me describes the device of token.
func (c *Client) Me(ctx context.Context, token string) (*Session, error) {
	var s Session
	return &s, c.jsonCall(ctx, call{method: http.MethodGet, path: "/me", token: token}, &s)
}

// Revoke revokes the device token itself.
func (c *Client) Revoke(ctx context.Context, token string) error {
	return c.jsonCall(ctx, call{method: http.MethodDelete, path: "/me", token: token}, nil)
}

func recPath(id string, suffix string) string { return "/recordings/" + url.PathEscape(id) + suffix }

// CreateRecording registers a recording before its upload: its id and the bytes already
// accepted.
func (c *Client) CreateRecording(ctx context.Context, token string, req CreateRequest) (id string, offset int64, err error) {
	var out struct {
		ID     string `json:"id"`
		Offset int64  `json:"offset"`
	}
	if err := c.jsonCall(ctx, call{method: http.MethodPost, path: "/recordings", token: token, json: req}, &out); err != nil {
		return "", 0, err
	}
	if out.ID == "" {
		return "", 0, &Error{Status: http.StatusOK, Code: CodeHTTP, Message: "create answer without an id", Offset: -1}
	}
	return out.ID, out.Offset, nil
}

// Offset asks how many bytes of the upload the server holds (HEAD …/data).
func (c *Client) Offset(ctx context.Context, token, id string) (int64, error) {
	ans, _, err := c.do(ctx, call{method: http.MethodHead, path: recPath(id, "/data"), token: token, allow: []int{http.StatusConflict}})
	if err != nil {
		return 0, err
	}
	if ans.offset >= 0 {
		return ans.offset, nil
	}
	return 0, &Error{Status: ans.status, Code: CodeHTTP, Message: "missing Upload-Offset", Offset: -1}
}

// PutChunk uploads chunk at start of a total-byte file. conflict = the server expected
// another offset (409); offset is the one it holds now either way.
func (c *Client) PutChunk(ctx context.Context, token, id string, start int64, chunk []byte, total int64) (offset int64, conflict bool, err error) {
	end := start + int64(len(chunk)) - 1
	ans, _, err := c.do(ctx, call{
		method: http.MethodPut, path: recPath(id, "/data"), token: token, body: chunk,
		headers: map[string]string{"Content-Range": fmt.Sprintf("bytes %d-%d/%d", start, end, total)},
		allow:   []int{http.StatusConflict}, timeout: c.PutTimeout,
	})
	if err != nil {
		return 0, false, err
	}
	off := ans.offset
	if ans.status == http.StatusConflict {
		if off < 0 {
			return 0, false, &Error{Status: ans.status, Code: CodeOffsetMismatch, Message: "409 without Upload-Offset", Offset: -1}
		}
		return off, true, nil
	}
	if off < 0 {
		off = end + 1
	}
	return off, false, nil
}

// Complete finishes an upload whose bytes were all accepted.
func (c *Client) Complete(ctx context.Context, token, id string) (*RecordingStatus, error) {
	var st RecordingStatus
	return &st, c.jsonCall(ctx, call{method: http.MethodPost, path: recPath(id, "/complete"), token: token}, &st)
}

// Recording reads the processing status.
func (c *Client) Recording(ctx context.Context, token, id string) (*RecordingStatus, error) {
	var st RecordingStatus
	return &st, c.jsonCall(ctx, call{method: http.MethodGet, path: recPath(id, ""), token: token}, &st)
}

// Upload uploads a whole file (f, req.SizeBytes bytes) and completes it. id is the server's
// recording id from an earlier attempt ("" = create; create is idempotent on
// req.ClientID); onID is called with a new id before the first byte goes out, so a later
// attempt resumes (HEAD) instead of starting over. Retryable failures are repeated with
// backoff up to MaxRetries in a row; any other error is returned (the caller decides
// whether the whole upload is retried later).
func (c *Client) Upload(ctx context.Context, token string, f io.ReaderAt, req CreateRequest, id string, onID func(string) error) (*RecordingStatus, error) {
	total := req.SizeBytes
	chunkSize := c.ChunkSize
	if chunkSize <= 0 {
		chunkSize = DefaultChunkSize
	}
	offset := int64(-1) // unknown: ask the server
	failures, conflicts := 0, 0
	buf := make([]byte, min(chunkSize, max(total, 1)))
	survive := func(err error) error {
		e, ok := AsError(err)
		if !ok || !e.Retryable() || ctx.Err() != nil {
			return err
		}
		failures++
		if failures > c.MaxRetries {
			return err
		}
		t := time.NewTimer(max(c.Backoff(failures), e.RetryAfter))
		defer t.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
		offset = -1 // re-sync with the server
		return nil
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var err error
		switch {
		case id == "":
			var off int64
			if id, off, err = c.CreateRecording(ctx, token, req); err == nil {
				offset = off
				if onID != nil {
					if err := onID(id); err != nil {
						return nil, err
					}
				}
			}
		case offset < 0:
			offset, err = c.Offset(ctx, token, id)
			if e, ok := AsError(err); ok && e.Status == http.StatusNotFound && e.Code != CodeServerUnsupported {
				id, offset, err = "", -1, nil // lost on the server: create again (same client_id)
				continue
			}
		case offset < total:
			n := min(chunkSize, total-offset)
			// ReadAt may report io.EOF together with the last full chunk.
			if k, rerr := f.ReadAt(buf[:n], offset); int64(k) != n {
				return nil, fmt.Errorf("gptunnel: read recording at %d: %d of %d bytes: %w", offset, k, n, rerr)
			}
			var conflict bool
			var off int64
			if off, conflict, err = c.PutChunk(ctx, token, id, offset, buf[:n], total); err == nil {
				offset = off
				if conflict { // the server holds another offset (0 = start over)
					if conflicts++; conflicts > 20 {
						return nil, &Error{Status: http.StatusConflict, Code: CodeOffsetMismatch, Message: "upload offset keeps conflicting", Offset: off}
					}
				} else {
					failures, conflicts = 0, 0
				}
			}
		default:
			var st *RecordingStatus
			if st, err = c.Complete(ctx, token, id); err == nil {
				return st, nil
			}
			if e, ok := AsError(err); ok && (e.Status == http.StatusConflict || e.Code == CodeIncomplete) {
				if conflicts++; conflicts > 20 {
					return nil, err
				}
				offset, err = e.Offset, nil // continue from the server's offset (-1: ask)
			}
		}
		if err != nil {
			if err := survive(err); err != nil {
				return nil, err
			}
		}
	}
}
