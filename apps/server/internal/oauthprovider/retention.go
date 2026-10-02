package oauthprovider

import (
	"context"
	"log/slog"
	"time"

	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Retention of provider protocol state. Requests die at expiry (10 min); codes and
// finished grant families are kept for ReplayWindow as reuse evidence (a replayed
// code or rotated refresh token still revokes its family inside the window); access
// tokens are useless once expired and leave after a short grace.
const (
	SweepInterval      = 10 * time.Minute
	ReplayWindow       = 24 * time.Hour
	AccessTokenGrace   = time.Hour
	sweepBatch         = 1000
	sweepBatchesPerRun = 50
)

// Run sweeps expired provider state every interval until ctx is done; with Redis
// only one API replica sweeps per interval (a lock key, like the boards sweeper).
func (s *Service) Run(ctx context.Context, r rueidis.Client, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if r == nil || r.Do(ctx, r.B().Set().Key(redisx.Key("oauth:sweep")).Value("1").Nx().Ex(max(interval-time.Minute, time.Second)).Build()).Error() == nil {
			if n, err := s.Sweep(ctx); err != nil && ctx.Err() == nil {
				slog.WarnContext(ctx, "oauthprovider: retention sweep", "err", err)
			} else if n > 0 {
				slog.InfoContext(ctx, "oauthprovider: expired protocol state deleted", "rows", n)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Sweep deletes expired authorization requests, codes past the replay window,
// expired access tokens and finished (expired, revoked or superseded) grants with
// their codes/tokens, in bounded batches. It returns the number of deleted rows
// (cascaded rows not counted).
func (s *Service) Sweep(ctx context.Context) (int64, error) {
	q := s.c.DB.Q
	steps := []func() (int64, error){
		func() (int64, error) { return q.DeleteExpiredOAuthRequests(ctx, sweepBatch) },
		func() (int64, error) {
			return q.DeleteExpiredOAuthCodes(ctx, sqlc.DeleteExpiredOAuthCodesParams{Batch: sweepBatch, WindowSeconds: int32(ReplayWindow / time.Second)})
		},
		func() (int64, error) {
			return q.DeleteExpiredOAuthAccessTokens(ctx, sqlc.DeleteExpiredOAuthAccessTokensParams{Batch: sweepBatch, WindowSeconds: int32(AccessTokenGrace / time.Second)})
		},
		func() (int64, error) {
			return q.DeleteFinishedOAuthGrants(ctx, sqlc.DeleteFinishedOAuthGrantsParams{Batch: sweepBatch, WindowSeconds: int32(ReplayWindow / time.Second)})
		},
	}
	var total int64
	for _, step := range steps {
		for range sweepBatchesPerRun {
			n, err := step()
			if err != nil {
				return total, err
			}
			total += n
			if n < sweepBatch {
				break
			}
		}
	}
	return total, nil
}
