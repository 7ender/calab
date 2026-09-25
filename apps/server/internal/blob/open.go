package blob

import (
	"errors"
	"fmt"
)

// Driver names for STORAGE_DRIVER.
const (
	DriverFS = "fs"
	DriverS3 = "s3"
)

// Open returns the configured driver. The s3 driver is planned (ADR-0011, stage 5).
func Open(driver, path string) (Store, error) {
	switch driver {
	case DriverFS:
		return NewFS(path)
	case DriverS3:
		return nil, errors.New("blob: STORAGE_DRIVER=s3 is not implemented yet (ADR-0011)")
	default:
		return nil, fmt.Errorf("blob: unknown STORAGE_DRIVER %q", driver)
	}
}
