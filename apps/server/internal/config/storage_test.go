package config

import (
	"strings"
	"testing"
)

func TestStorageS3(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x@localhost/x")
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.StorageDriver != "fs" || c.StorageS3Region != "us-east-1" || !c.StorageS3ForcePathStyle {
		t.Fatalf("defaults: %q %q %v", c.StorageDriver, c.StorageS3Region, c.StorageS3ForcePathStyle)
	}

	t.Setenv("STORAGE_DRIVER", "s3")
	_, err = Load()
	for _, name := range []string{"STORAGE_S3_ENDPOINT", "STORAGE_S3_BUCKET", "STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY"} {
		if err == nil || !strings.Contains(err.Error(), name) {
			t.Fatalf("s3 without %s: %v", name, err)
		}
	}

	t.Setenv("STORAGE_S3_ENDPOINT", "https://storage.yandexcloud.net")
	t.Setenv("STORAGE_S3_REGION", "ru-central1")
	t.Setenv("STORAGE_S3_BUCKET", "files-bucket")
	t.Setenv("STORAGE_S3_ACCESS_KEY_ID", "key-id")
	t.Setenv("STORAGE_S3_SECRET_ACCESS_KEY", "top-secret-value")
	t.Setenv("STORAGE_S3_KEY_PREFIX", "calab/")
	t.Setenv("STORAGE_S3_FORCE_PATH_STYLE", "false")
	c, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.StorageS3Bucket != "files-bucket" || c.StorageS3Region != "ru-central1" || c.StorageS3KeyPrefix != "calab/" || c.StorageS3ForcePathStyle {
		t.Fatalf("parsed: %q %q %q %v", c.StorageS3Bucket, c.StorageS3Region, c.StorageS3KeyPrefix, c.StorageS3ForcePathStyle)
	}

	t.Setenv("STORAGE_S3_ENDPOINT", "storage.yandexcloud.net")
	_, err = Load()
	if err == nil || !strings.Contains(err.Error(), "STORAGE_S3_ENDPOINT") {
		t.Fatalf("relative endpoint: %v", err)
	}
	if strings.Contains(err.Error(), "top-secret-value") {
		t.Fatal("secret in the error")
	}
}

// The recordings volume is required only with STORAGE_DRIVER=fs: with s3 the egress uploads
// recordings into the files bucket.
func TestRecordingsVolumeOnlyForFS(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x@localhost/x")
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("RECORDING_EGRESS_DIR", "out")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "RECORDING_EGRESS_DIR") {
		t.Fatalf("fs, relative egress dir: %v", err)
	}

	t.Setenv("STORAGE_DRIVER", "s3")
	t.Setenv("STORAGE_S3_ENDPOINT", "https://s3.example.test")
	t.Setenv("STORAGE_S3_BUCKET", "files-bucket")
	t.Setenv("STORAGE_S3_ACCESS_KEY_ID", "key-id")
	t.Setenv("STORAGE_S3_SECRET_ACCESS_KEY", "test-secret")
	if _, err := Load(); err != nil {
		t.Fatalf("s3 without a recordings volume: %v", err)
	}
	t.Setenv("RECORDING_MAX_CONCURRENT", "0")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "RECORDING_MAX_CONCURRENT") || strings.Contains(err.Error(), "RECORDINGS_PATH") {
		t.Fatalf("s3, no concurrent recordings: %v", err)
	}
}
