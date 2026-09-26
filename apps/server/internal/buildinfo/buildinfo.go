// Package buildinfo carries the build stamp and license information (GET /api/version).
package buildinfo

import (
	"net/http"
	"runtime/debug"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Set at link time by the Dockerfile:
//
//	-ldflags "-X github.com/calaba/calaba/server/internal/buildinfo.Version=… -X …Commit=…"
var (
	Version = "dev"
	Commit  = ""
)

// License terms of this software (LICENSE, NOTICE, COMMERCIAL-LICENSE.md at the repo root).
const (
	License           = "BUSL-1.1"
	CommercialLicense = "https://gptunnel.ai"
	Attribution       = "Powered by GPTunneL"
	AttributionURL    = "https://gptunnel.ai"
)

// commit returns the stamped commit, else the VCS revision Go embedded (local builds from
// a git checkout), else "unknown".
func commit() string {
	if Commit != "" {
		return Commit
	}
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, s := range bi.Settings {
			if s.Key == "vcs.revision" && len(s.Value) >= 7 {
				return s.Value[:7]
			}
		}
	}
	return "unknown"
}

// Info returns the build and license information.
func Info() *v1.GetVersionResponse {
	return &v1.GetVersionResponse{
		Version: Version, Commit: commit(), License: License,
		CommercialLicense: CommercialLicense, Attribution: Attribution, Url: AttributionURL,
	}
}

// Routes registers the public GET /api/version.
func Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/version", httpx.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) error {
		httpx.Write(w, http.StatusOK, Info())
		return nil
	}))
}
