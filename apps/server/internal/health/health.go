// Package health serves liveness (/healthz) and readiness (/readyz) probes.
package health

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/rueidis"
)

// Routes registers /healthz and /readyz (outside /api; not proxied publicly by Caddy).
func Routes(mux *http.ServeMux, pool *pgxpool.Pool, redis rueidis.Client) {
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		checks := map[string]string{"postgres": "ok", "redis": "ok"}
		status := http.StatusOK
		if err := pool.Ping(ctx); err != nil {
			checks["postgres"], status = err.Error(), http.StatusServiceUnavailable
		}
		if err := redis.Do(ctx, redis.B().Ping().Build()).Error(); err != nil {
			checks["redis"], status = err.Error(), http.StatusServiceUnavailable
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(checks)
	})
}
