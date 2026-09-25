package httpx

import (
	"net/http"
	"slices"
	"strings"
)

// SameOrigin is the CSRF check for cookie-authenticated requests: the browser-set Origin must
// be one of allowed (exact scheme://host[:port]); without Origin, Sec-Fetch-Site must say
// same-origin. A request carrying neither header is rejected: every browser we support
// sends Origin on POST, and non-browser clients use bearer tokens, not cookies.
func SameOrigin(r *http.Request, allowed []string) bool {
	if o := r.Header.Get("Origin"); o != "" {
		return slices.Contains(allowed, strings.ToLower(o))
	}
	return r.Header.Get("Sec-Fetch-Site") == "same-origin"
}
