package httpx

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// MaxJSONBody caps REST request bodies (file uploads use their own path).
const MaxJSONBody = 1 << 20

var (
	// JSON field names are lowerCamelCase (UseProtoNames=false); scalar defaults are emitted.
	marshalOpts   = protojson.MarshalOptions{EmitDefaultValues: true}
	unmarshalOpts = protojson.UnmarshalOptions{DiscardUnknown: true}
)

// Decode reads a protojson body into msg. An empty body leaves msg zero-valued.
func Decode(w http.ResponseWriter, r *http.Request, msg proto.Message) error {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxJSONBody))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return Coded(http.StatusRequestEntityTooLarge, v1.ErrorCode_ERROR_CODE_PAYLOAD_TOO_LARGE, "request body too large")
		}
		return BadRequest("cannot read body")
	}
	if len(body) == 0 {
		return nil
	}
	if err := unmarshalOpts.Unmarshal(body, msg); err != nil {
		return BadRequest("invalid JSON: " + err.Error())
	}
	return nil
}

// Write encodes msg as protojson with the given status.
func Write(w http.ResponseWriter, status int, msg proto.Message) {
	b, err := marshalOpts.Marshal(msg)
	if err != nil {
		slog.Error("marshal response", "err", err)
		http.Error(w, `{"code":"ERROR_CODE_INTERNAL","message":"internal error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

// NoContent writes 204.
func NoContent(w http.ResponseWriter) {
	w.WriteHeader(http.StatusNoContent)
}

// WriteError writes err as ApiError JSON and logs server-side failures.
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	e := AsError(err)
	if e.RetryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(e.RetryAfter.Seconds())))
	}
	if e.Status >= 500 {
		slog.ErrorContext(r.Context(), "request failed", "err", err, "request_id", RequestID(r.Context()),
			"method", r.Method, "path", r.URL.Path)
	}
	Write(w, e.Status, e.Proto())
}
