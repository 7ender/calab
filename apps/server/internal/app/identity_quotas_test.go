package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/google/uuid"
)

func TestIdentityProtocolWrapperErrors(t *testing.T) {
	for _, tc := range []struct {
		name    string
		enabled bool
		err     error
		status  int
		code    string
	}{
		{"disabled", false, nil, 503, "server_error"}, {"quota", true, httpx.RateLimited(), 429, "temporarily_unavailable"}, {"dependency", true, httpx.Unavailable(errors.New("private connection detail")), 503, "server_error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := &routeRecorder{ServeMux: http.NewServeMux()}
			registrar := identityRegistrar{mux: recorder, enabled: tc.enabled, quota: func(string, *http.Request) error { return tc.err }}
			registrar.Handle("POST /oidc/workspaces/{workspace}/token", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("rejected request entered provider") }))
			response := httptest.NewRecorder()
			request := httptest.NewRequestWithContext(context.Background(), "POST", "/oidc/workspaces/"+uuid.NewString()+"/token", nil)
			recorder.ServeHTTP(response, request)
			var body map[string]string
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if response.Code != tc.status || body["error"] != tc.code || len(body) != 1 || strings.Contains(response.Body.String(), "private") {
				t.Fatalf("protocol wire format %d %s", response.Code, response.Body.String())
			}
			for name, want := range map[string]string{"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Type": "application/json", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"} {
				if response.Header().Get(name) != want {
					t.Fatalf("missing protocol header %s", name)
				}
			}
		})
	}
}

func TestQuotaParsingPreservesExactAcceptedBody(t *testing.T) {
	for _, body := range []string{"client_id=public&grant_type=authorization_code&code=a%2Bb", "grant_type=refresh_token&client_id=public&refresh_token=opaque%25secret"} {
		request := httptest.NewRequestWithContext(context.Background(), "POST", "/oidc/workspaces/"+uuid.NewString()+"/token", bytes.NewBufferString(body))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		id, err := quotaFormClientID(request)
		if id != "public" || err != nil {
			t.Fatalf("public client bucket: %q %v", id, err)
		}
		restored, err := io.ReadAll(request.Body)
		if err != nil || string(restored) != body || request.PostForm != nil || request.Form != nil {
			t.Fatal("quota parsing modified the provider input")
		}
	}
	for _, body := range []string{"client_id=a&client_id=b", strings.Repeat("x", (16<<10)+1)} {
		request := httptest.NewRequestWithContext(context.Background(), "POST", "/oidc/workspaces/"+uuid.NewString()+"/token", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if id, err := quotaFormClientID(request); id != "" || httpx.AsError(err).Status != 400 {
			t.Fatal("ambiguous or oversized form selected a client bucket")
		}
	}
	request := httptest.NewRequestWithContext(context.Background(), "POST", "/oidc/workspaces/"+uuid.NewString()+"/token", strings.NewReader("client_id=a&client_secret=never-trusted"))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if id, err := quotaFormClientID(request); id != "" || err != nil {
		t.Fatal("untrusted credentials selected a client bucket")
	}
}
