// Package httpx holds HTTP plumbing: the ApiError model, protojson encoding and middleware.
package httpx

import (
	"errors"
	"fmt"
	"net/http"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Error is an API error: machine code + HTTP status + safe message for the client.
type Error struct {
	Status  int
	Code    v1.ErrorCode
	Message string
	Field   string
	Err     error // internal cause, logged but never sent
}

func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Err)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error { return e.Err }

// Proto converts the error to the wire message.
func (e *Error) Proto() *v1.ApiError {
	return &v1.ApiError{Code: e.Code, Message: e.Message, Field: e.Field}
}

// AsError extracts an *Error from err; unknown errors become 500 INTERNAL.
func AsError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return &Error{Status: http.StatusInternalServerError, Code: v1.ErrorCode_ERROR_CODE_INTERNAL, Message: "internal error", Err: err}
}

func newErr(status int, code v1.ErrorCode, msg string) *Error {
	return &Error{Status: status, Code: code, Message: msg}
}

// BadRequest is a malformed request (400).
func BadRequest(msg string) *Error {
	return newErr(http.StatusBadRequest, v1.ErrorCode_ERROR_CODE_BAD_REQUEST, msg)
}

// Validation reports an invalid field value; field is the lowerCamelCase JSON name.
func Validation(field, msg string) *Error {
	e := newErr(http.StatusUnprocessableEntity, v1.ErrorCode_ERROR_CODE_VALIDATION, msg)
	e.Field = field
	return e
}

// Unauthenticated is a missing or invalid access token (401).
func Unauthenticated(msg string) *Error {
	return newErr(http.StatusUnauthorized, v1.ErrorCode_ERROR_CODE_UNAUTHENTICATED, msg)
}

// Forbidden is a missing permission (403).
func Forbidden(msg string) *Error {
	if msg == "" {
		msg = "missing permission"
	}
	return newErr(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_FORBIDDEN, msg)
}

// NotFound reports that `what` does not exist or is hidden from the caller (404).
func NotFound(what string) *Error {
	return newErr(http.StatusNotFound, v1.ErrorCode_ERROR_CODE_NOT_FOUND, what+" not found")
}

// Conflict is a uniqueness or state conflict (409).
func Conflict(msg string) *Error {
	return newErr(http.StatusConflict, v1.ErrorCode_ERROR_CODE_CONFLICT, msg)
}

// RateLimited is 429.
func RateLimited() *Error {
	return newErr(http.StatusTooManyRequests, v1.ErrorCode_ERROR_CODE_RATE_LIMITED, "too many requests")
}

// Unavailable is a dependency failure (503).
func Unavailable(err error) *Error {
	e := newErr(http.StatusServiceUnavailable, v1.ErrorCode_ERROR_CODE_UNAVAILABLE, "service unavailable")
	e.Err = err
	return e
}

// Coded builds an error with an explicit status and code.
func Coded(status int, code v1.ErrorCode, msg string) *Error {
	return newErr(status, code, msg)
}

// Internal wraps an unexpected error.
func Internal(err error) *Error {
	return AsError(err)
}
