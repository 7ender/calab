package blob

import (
	"context"
	"fmt"
)

// Driver names for STORAGE_DRIVER.
const (
	DriverFS = "fs"
	DriverS3 = "s3"
)

// Config selects and configures the driver (STORAGE_* variables, see config.Config).
type Config struct {
	Driver string   // DriverFS or DriverS3
	Path   string   // fs: root directory (STORAGE_PATH)
	S3     S3Config // s3: bucket and credentials (STORAGE_S3_*)
}

// Open returns the configured driver. The s3 driver checks access to its bucket first, so a
// wrong endpoint, bucket or key stops the server at startup, not at the first upload.
func Open(ctx context.Context, cfg Config) (Store, error) {
	switch cfg.Driver {
	case DriverFS:
		return NewFS(cfg.Path)
	case DriverS3:
		return NewS3(ctx, cfg.S3)
	default:
		return nil, fmt.Errorf("blob: unknown STORAGE_DRIVER %q", cfg.Driver)
	}
}
