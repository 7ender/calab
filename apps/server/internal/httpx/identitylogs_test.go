package httpx

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestConsentCapabilitiesNeverAppearInHTTPLogs(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(previous)
	secret := "calab_request_sensitive_capability" //nolint:gosec // Non-secret redaction test marker.
	mux := http.NewServeMux()
	mux.Handle("POST /api/oauth/requests/{request}/bind", HandlerFunc(func(http.ResponseWriter, *http.Request) error {
		return fmt.Errorf("database error contains %s", secret)
	}))
	handler := Observe(mux)
	for _, raw := range []string{"/api/oauth/requests/" + secret + "/bind", "/api/oauth/requests/" + secret + "/unknown", "/api/oauth//requests/" + secret + "/bind", "/api/oauth/requests/" + secret + "/../bind", "/api/oauth/requests%2F" + secret + "%2Fbind"} {
		req := httptest.NewRequestWithContext(context.Background(), "POST", raw, nil)
		handler.ServeHTTP(httptest.NewRecorder(), req)
		canceled, cancel := context.WithCancel(context.Background())
		cancel()
		WriteError(httptest.NewRecorder(), req.WithContext(canceled), fmt.Errorf("dependency %s", secret))
	}
	if strings.Contains(logs.String(), secret) {
		t.Fatalf("consent capability leaked in logs: %s", logs.String())
	}
	if !strings.Contains(logs.String(), "/api/oauth/requests/{request}/bind") || !strings.Contains(logs.String(), "unmatched") {
		t.Fatal("redaction lost useful route evidence")
	}
}
