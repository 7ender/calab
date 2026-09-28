package files

import (
	"context"
	"log/slog"
	"time"

	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// OrphanAge is the age after which uploads not attached (and not an avatar/icon) after this long are deleted.
const OrphanAge = 24 * time.Hour

// CleanupOrphans deletes orphaned files once; only one instance runs it at a time
// (transaction-scoped advisory lock). Returns the number of deleted files.
func (s *Service) CleanupOrphans(ctx context.Context) (int, error) {
	deleted := 0
	var gone []sqlc.File
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		ok, err := q.TryAdvisoryXactLock(ctx, "calaba.files.cleanup")
		if err != nil || !ok {
			return err
		}
		rows, err := q.ListOrphanFiles(ctx, time.Now().Add(-OrphanAge))
		if err != nil {
			return err
		}
		for _, f := range rows {
			n, err := q.DeleteFile(ctx, f.ID)
			if err != nil {
				return err
			}
			if n == 0 {
				continue
			}
			if f.WorkspaceID != nil {
				if err := q.ReleaseQuota(ctx, sqlc.ReleaseQuotaParams{ID: *f.WorkspaceID, Size: f.Size}); err != nil {
					return err
				}
			}
			gone = append(gone, f)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	// Rows are gone (committed) before blobs: a crash here leaks bytes, never dangling rows.
	for _, f := range gone {
		_ = s.store.Delete(ctx, f.Key)
		blob.DeleteThumbs(ctx, s.store, f.Key, f.ThumbnailKey)
		deleted++
	}
	return deleted, nil
}

// RunCleanup runs CleanupOrphans every interval until ctx is done.
func (s *Service) RunCleanup(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := s.CleanupOrphans(ctx)
			if err != nil {
				slog.Error("orphan file cleanup", "err", err)
			} else if n > 0 {
				slog.Info("orphan files deleted", "count", n)
			}
		}
	}
}
