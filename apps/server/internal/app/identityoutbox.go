package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/redisx"
)

// DeliverIdentityInvalidations consumes only committed outbox rows. Publication happens
// while holding the delivery row lock; marking follows successful publication. A crash
// can duplicate delivery, which consumers safely coalesce and verify against fresh DB state.
func (a *App) DeliverIdentityInvalidations(ctx context.Context) error {
	return a.identityDB.Tx(ctx, func(q *sqlc.Queries) error {
		rows, err := q.ListIdentityInvalidationsForUpdate(ctx, 64)
		if err != nil {
			return err
		}
		for _, row := range rows {
			// access_version is the version of user's own access row ("" = workspace-wide
			// notice, policy only); consumers compare it only with that user's sessions.
			user := ""
			if row.UserID != nil {
				user = row.UserID.String()
			}
			payload, err := json.Marshal(struct {
				ID            string `json:"id"`
				Workspace     string `json:"workspace"`
				User          string `json:"user"`
				PolicyVersion int64  `json:"policy_version"`
				AccessVersion int64  `json:"access_version"`
			}{row.ID.String(), row.WorkspaceID.String(), user, row.PolicyVersion, row.AccessVersion})
			if err != nil {
				return err
			}
			if err = a.redis.Do(ctx, a.redis.B().Publish().Channel(redisx.Channel("identity:invalidated")).Message(string(payload)).Build()).Error(); err != nil {
				return err
			}
			a.Gateway.IdentityChanged()
			if a.RTC != nil {
				a.RTC.IdentityChanged()
			}
			if err = q.MarkIdentityInvalidationDelivered(ctx, row.ID); err != nil {
				return err
			}
		}
		return nil
	})
}

func (a *App) runIdentityInvalidations(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		work, cancel := context.WithTimeout(ctx, 2*time.Second)
		err := a.DeliverIdentityInvalidations(work)
		cancel()
		if err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "identity invalidation delivery failed", "err", err)
		}
	}
}
