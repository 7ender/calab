//go:build integration

package blob

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// testS3Config is the S3 of the integration tests: TEST_S3_* (internal/blob/testdata/garage.sh
// starts a Garage and prints them), with a key prefix of its own per run.
func testS3Config(t *testing.T) S3Config {
	t.Helper()
	endpoint := os.Getenv("TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("TEST_S3_ENDPOINT not set (internal/blob/testdata/garage.sh starts a Garage)")
	}
	run := make([]byte, 6)
	_, _ = rand.Read(run)
	return S3Config{
		Endpoint:        endpoint,
		Region:          os.Getenv("TEST_S3_REGION"),
		Bucket:          os.Getenv("TEST_S3_BUCKET"),
		AccessKeyID:     os.Getenv("TEST_S3_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("TEST_S3_SECRET_ACCESS_KEY"),
		KeyPrefix:       "calab-test/" + hex.EncodeToString(run),
		ForcePathStyle:  true,
	}
}

// testS3 opens the driver and removes what the test leaves under its prefix.
func testS3(t *testing.T) *S3 {
	t.Helper()
	s, err := NewS3(context.Background(), testS3Config(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		c := s.api.(*s3.Client)
		p := s3.NewListObjectsV2Paginator(c, &s3.ListObjectsV2Input{Bucket: &s.bucket, Prefix: &s.prefix})
		for p.HasMorePages() {
			page, err := p.NextPage(ctx)
			if err != nil {
				t.Logf("cleanup: %v", err)
				return
			}
			for _, o := range page.Contents {
				_, _ = c.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &s.bucket, Key: o.Key})
			}
		}
	})
	return s
}

func TestS3Contract(t *testing.T) {
	s := testS3(t)
	testStoreContract(t, s)
	// Failed Puts aborted their multipart uploads (the parts would stay stored invisibly).
	out, err := s.api.(*s3.Client).ListMultipartUploads(context.Background(),
		&s3.ListMultipartUploadsInput{Bucket: &s.bucket, Prefix: &s.prefix})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Uploads) != 0 {
		t.Fatalf("%d multipart uploads left behind", len(out.Uploads))
	}
}

func TestS3ContentTypeReal(t *testing.T) {
	s := testS3(t)
	ctx := context.Background()
	key := newKey()
	if err := s.Put(ctx, key, strings.NewReader("RIFF"), 4, "image/webp"); err != nil {
		t.Fatal(err)
	}
	if m, err := s.Stat(ctx, key); err != nil || m.ContentType != "image/webp" || m.Size != 4 {
		t.Fatalf("%+v %v", m, err)
	}
}

// An object replaced after Get fails the read (If-Match on the ETag) instead of mixing versions.
func TestS3ReplacedWhileReading(t *testing.T) {
	s := testS3(t)
	ctx := context.Background()
	key := newKey()
	mustPut(t, s, key, []byte("version 1"), -1)
	r, _, err := s.Get(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close() }()
	mustPut(t, s, key, []byte("version 2"), -1)
	if b, err := io.ReadAll(r); err == nil {
		t.Fatalf("read a replaced object: %q", b)
	}
}

// Wrong bucket or key: the driver does not start; the secret never shows in the error.
func TestS3OpenChecksAccess(t *testing.T) {
	cfg := testS3Config(t)
	ctx := context.Background()
	if _, err := Open(ctx, Config{Driver: DriverS3, S3: cfg}); err != nil {
		t.Fatal(err)
	}
	noBucket := cfg
	noBucket.Bucket = cfg.Bucket + "-missing"
	if _, err := NewS3(ctx, noBucket); err == nil {
		t.Fatal("missing bucket accepted")
	}
	badSecret := cfg
	badSecret.SecretAccessKey = strings.Repeat("0", len(cfg.SecretAccessKey))
	_, err := NewS3(ctx, badSecret)
	if err == nil {
		t.Fatal("wrong secret accepted")
	}
	if strings.Contains(err.Error(), badSecret.SecretAccessKey) || strings.Contains(err.Error(), cfg.SecretAccessKey) {
		t.Fatal("secret in the error")
	}
}
