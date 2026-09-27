package httpx

import (
	"net/http"

	"github.com/google/uuid"
)

// PathUUID parses a uuid path parameter; a malformed id is reported as not found.
func PathUUID(r *http.Request, name, what string) (uuid.UUID, error) {
	id, err := uuid.Parse(r.PathValue(name))
	if err != nil {
		return uuid.Nil, NotFound(what)
	}
	return id, nil
}

// Router is what route registration needs. *http.ServeMux implements it; the app wraps the
// mux to record every pattern (the bot route table test, ADR-0031).
type Router interface {
	Handle(pattern string, handler http.Handler)
	HandleFunc(pattern string, handler func(http.ResponseWriter, *http.Request))
}
