package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthcheck(t *testing.T) {
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/readyz" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(status)
	}))
	defer srv.Close()
	addr := strings.TrimPrefix(srv.URL, "http://")
	if err := healthcheck(addr); err != nil {
		t.Fatalf("ready server: %v", err)
	}
	// 0.0.0.0 binds are probed on loopback.
	if err := healthcheck("0.0.0.0:" + addr[strings.LastIndex(addr, ":")+1:]); err != nil {
		t.Fatalf("0.0.0.0: %v", err)
	}
	status = http.StatusServiceUnavailable
	if err := healthcheck(addr); err == nil {
		t.Fatal("not-ready server reported healthy")
	}
	srv.Close()
	if err := healthcheck(addr); err == nil {
		t.Fatal("down server reported healthy")
	}
}
