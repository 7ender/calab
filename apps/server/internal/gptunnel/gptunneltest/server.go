// Package gptunneltest is an in-memory fake of GPTunneL's meeting device API for tests. It
// checks what a real server would: the Bearer token, Content-Range syntax and bounds, chunks
// that start exactly at the accepted offset, the declared total size and a complete upload
// before /complete. Faults can be injected (503s, a lost offset, statuses, errors).
package gptunneltest

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// Recording is the fake's view of one recording.
type Recording struct {
	ID, ClientID, Title, Kind, Mime, StartedAt string
	Size                                       int64
	DurationSec                                int64
	Data                                       []byte
	Completed                                  bool
	Token                                      string
	Polls                                      int
	Status, Error                              string
	Puts                                       int // accepted chunks
}

// Server is the fake. Fields under "faults" may be changed between requests (use Lock).
type Server struct {
	*httptest.Server
	mu      sync.Mutex
	codes   map[string]bool
	tokens  map[string]bool // token -> active
	recs    map[string]*Recording
	byCID   map[string]string
	seq     int
	WebBase string

	// faults
	FailPuts      int      // the next N PUTs answer 503 unavailable (Retry-After 0)
	FailGets      int      // the next N status GETs answer 502 (counted as polls)
	LoseOffset    bool     // the next PUT answers 409 with Upload-Offset 0 and drops the bytes
	CreateError   string   // create answers 402 with this error code (e.g. insufficient_balance)
	Statuses      []string // statuses GET returns after complete, one per poll; the last repeats
	FailError     string   // error code reported with status "failed"
	MaxChunk      int64    // larger chunks are rejected (413); 0 = 8 MiB
	Requests      []string // "METHOD path" log
	RevokedCalled int      // DELETE /me calls
}

// New starts a fake. Close it when done.
func New() *Server {
	s := &Server{codes: map[string]bool{}, tokens: map[string]bool{}, recs: map[string]*Recording{}, byCID: map[string]string{}}
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	s.WebBase = "https://gptunnel.test"
	return s
}

// Lock guards the fault fields while a test changes them.
func (s *Server) Lock() { s.mu.Lock() }

// Unlock releases Lock.
func (s *Server) Unlock() { s.mu.Unlock() }

// AddCode makes code (normalized: upper case, no dashes/spaces) valid once.
func (s *Server) AddCode(code string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.codes[normCode(code)] = true
}

// RevokeAll revokes every device token (as the user would in GPTunneL's web).
func (s *Server) RevokeAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for t := range s.tokens {
		s.tokens[t] = false
	}
}

// TokenActive reports whether token is a live device token.
func (s *Server) TokenActive(token string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tokens[token]
}

// Recordings returns copies of all recordings.
func (s *Server) Recordings() []Recording {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Recording, 0, len(s.recs))
	for _, r := range s.recs {
		c := *r
		c.Data = append([]byte(nil), r.Data...)
		out = append(out, c)
	}
	return out
}

// ByClientID returns a copy of the recording created with clientID.
func (s *Server) ByClientID(clientID string) (Recording, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.recs[s.byCID[clientID]]
	if !ok {
		return Recording{}, false
	}
	c := *r
	c.Data = append([]byte(nil), r.Data...)
	return c, true
}

func normCode(c string) string {
	return strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(c))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]string{"error": code, "message": msg})
}

var contentRange = regexp.MustCompile(`^bytes (\d+)-(\d+)/(\d+)$`)

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Requests = append(s.Requests, r.Method+" "+r.URL.Path)
	path, ok := strings.CutPrefix(r.URL.Path, "/v1/meetings/device")
	if !ok {
		http.NotFound(w, r)
		return
	}
	if path == "/pair" && r.Method == http.MethodPost {
		s.pair(w, r)
		return
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	active, known := s.tokens[token]
	if !known {
		fail(w, 401, "unauthorized", "unknown token")
		return
	}
	if !active {
		fail(w, 401, "device_revoked", "device revoked")
		return
	}
	switch {
	case path == "/me" && r.Method == http.MethodGet:
		writeJSON(w, 200, s.session(""))
	case path == "/me" && r.Method == http.MethodDelete:
		s.tokens[token] = false
		s.RevokedCalled++
		w.WriteHeader(204)
	case path == "/recordings" && r.Method == http.MethodPost:
		s.create(w, r, token)
	case strings.HasPrefix(path, "/recordings/"):
		rest := strings.TrimPrefix(path, "/recordings/")
		id, sub, _ := strings.Cut(rest, "/")
		rec := s.recs[id]
		if rec == nil || rec.Token != token {
			fail(w, 404, "not_found", "no such recording")
			return
		}
		switch {
		case sub == "data" && r.Method == http.MethodHead:
			w.Header().Set("Upload-Offset", strconv.Itoa(len(rec.Data)))
			w.WriteHeader(200)
		case sub == "data" && r.Method == http.MethodPut:
			s.put(w, r, rec)
		case sub == "complete" && r.Method == http.MethodPost:
			if int64(len(rec.Data)) != rec.Size {
				w.Header().Set("Upload-Offset", strconv.Itoa(len(rec.Data)))
				fail(w, 409, "incomplete", "not all bytes received")
				return
			}
			rec.Completed, rec.Status = true, "uploaded"
			writeJSON(w, 200, s.status(rec))
		case sub == "" && r.Method == http.MethodGet:
			if s.FailGets > 0 {
				s.FailGets--
				rec.Polls++
				fail(w, 502, "internal", "bad gateway")
				return
			}
			if rec.Completed && len(s.Statuses) > 0 {
				i := min(rec.Polls, len(s.Statuses)-1)
				rec.Status = s.Statuses[i]
				if rec.Status == "failed" {
					rec.Error = s.FailError
				}
			}
			rec.Polls++
			writeJSON(w, 200, s.status(rec))
		default:
			fail(w, 405, "bad_request", "method")
		}
	default:
		fail(w, 404, "not_found", "route")
	}
}

func (s *Server) session(token string) map[string]any {
	out := map[string]any{
		"device":  map[string]any{"id": "dev-1", "name": "Calab · Team", "platform": "linux"},
		"user":    map[string]any{"id": "u-1", "name": "Test Account", "email": "acc@example.com"},
		"web_url": s.WebBase,
	}
	if token != "" {
		out["token"] = token
	}
	return out
}

func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	var req struct{ Code, Name, Platform, AppVersion string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" || req.Platform == "" {
		fail(w, 400, "bad_request", "body")
		return
	}
	code := normCode(req.Code)
	if !s.codes[code] {
		fail(w, 400, "invalid_code", "invalid or expired code")
		return
	}
	delete(s.codes, code)
	s.seq++
	token := fmt.Sprintf("tok-%d", s.seq)
	s.tokens[token] = true
	writeJSON(w, 200, s.session(token))
}

func (s *Server) create(w http.ResponseWriter, r *http.Request, token string) {
	var req struct {
		ClientID    string `json:"client_id"`
		Title       string `json:"title"`
		Kind        string `json:"kind"`
		Mime        string `json:"mime"`
		SizeBytes   int64  `json:"size_bytes"`
		DurationSec int64  `json:"duration_sec"`
		StartedAt   string `json:"started_at"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ClientID == "" || req.SizeBytes <= 0 ||
		(req.Mime != "video/mp4" && req.Mime != "audio/mpeg") || (req.Kind != "video" && req.Kind != "audio") {
		fail(w, 400, "bad_request", "invalid recording")
		return
	}
	if s.CreateError != "" {
		fail(w, 402, s.CreateError, s.CreateError)
		return
	}
	if id, ok := s.byCID[req.ClientID]; ok { // idempotent
		writeJSON(w, 200, map[string]any{"id": id, "offset": len(s.recs[id].Data)})
		return
	}
	s.seq++
	id := fmt.Sprintf("rec-%d", s.seq)
	s.recs[id] = &Recording{ID: id, ClientID: req.ClientID, Title: req.Title, Kind: req.Kind, Mime: req.Mime,
		Size: req.SizeBytes, DurationSec: req.DurationSec, StartedAt: req.StartedAt, Token: token, Status: "uploading"}
	s.byCID[req.ClientID] = id
	writeJSON(w, 200, map[string]any{"id": id, "offset": 0})
}

func (s *Server) put(w http.ResponseWriter, r *http.Request, rec *Recording) {
	if s.FailPuts > 0 {
		s.FailPuts--
		w.Header().Set("Retry-After", "0")
		fail(w, 503, "unavailable", "try again")
		return
	}
	m := contentRange.FindStringSubmatch(r.Header.Get("Content-Range"))
	if m == nil {
		fail(w, 400, "bad_request", "Content-Range")
		return
	}
	start, _ := strconv.ParseInt(m[1], 10, 64)
	end, _ := strconv.ParseInt(m[2], 10, 64)
	total, _ := strconv.ParseInt(m[3], 10, 64)
	limit := s.MaxChunk
	if limit <= 0 {
		limit = 8 << 20
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		fail(w, 400, "bad_request", "body")
		return
	}
	switch {
	case int64(len(body)) > limit:
		fail(w, 413, "too_large", "chunk too large")
		return
	case total != rec.Size || end < start || end >= total || int64(len(body)) != end-start+1:
		fail(w, 400, "bad_request", "Content-Range does not match the body / size")
		return
	}
	if s.LoseOffset {
		s.LoseOffset = false
		rec.Data = nil
		w.Header().Set("Upload-Offset", "0")
		fail(w, 409, "offset_mismatch", "start over")
		return
	}
	if start != int64(len(rec.Data)) {
		w.Header().Set("Upload-Offset", strconv.Itoa(len(rec.Data)))
		fail(w, 409, "offset_mismatch", "offset")
		return
	}
	rec.Data = append(rec.Data, body...)
	rec.Puts++
	w.Header().Set("Upload-Offset", strconv.Itoa(len(rec.Data)))
	w.WriteHeader(204)
}

func (s *Server) status(rec *Recording) map[string]any {
	var e any
	if rec.Error != "" {
		e = rec.Error
	}
	return map[string]any{"id": rec.ID, "status": rec.Status, "error": e, "offset": len(rec.Data),
		"web_url": s.WebBase + "/meetings/" + rec.ID}
}
