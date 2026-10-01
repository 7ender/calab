package app

import (
	"context"
	"log/slog"
	"time"
)

func (a *App) runIdentityDirectory(ctx context.Context) {
	for ctx.Err() == nil {
		err := a.Directory.Run(ctx)
		if ctx.Err() != nil {
			return
		}
		slog.WarnContext(ctx, "identity directory worker restarting", "err", err)
		timer := time.NewTimer(5 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
