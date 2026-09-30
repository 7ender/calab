package blob

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
)

// S3Config configures the s3 driver (STORAGE_S3_* variables).
type S3Config struct {
	Endpoint        string // S3 API URL, e.g. https://storage.yandexcloud.net
	Region          string // SigV4 signing region, e.g. ru-central1 (Garage: its s3_region)
	Bucket          string
	AccessKeyID     string
	SecretAccessKey string
	// KeyPrefix, if set, puts every object under "<KeyPrefix>/" (a bucket shared with other
	// data): "/"-separated segments of the key charset.
	KeyPrefix string
	// ForcePathStyle addresses objects as <endpoint>/<bucket>/<key> instead of
	// <bucket>.<endpoint host>/<key>.
	ForcePathStyle bool
}

func (c S3Config) validate() error {
	var missing []string
	for _, f := range []struct{ name, value string }{
		{"STORAGE_S3_ENDPOINT", c.Endpoint}, {"STORAGE_S3_REGION", c.Region}, {"STORAGE_S3_BUCKET", c.Bucket},
		{"STORAGE_S3_ACCESS_KEY_ID", c.AccessKeyID}, {"STORAGE_S3_SECRET_ACCESS_KEY", c.SecretAccessKey},
	} {
		if strings.TrimSpace(f.value) == "" {
			missing = append(missing, f.name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("blob s3: %s required", strings.Join(missing, ", "))
	}
	if u, err := url.Parse(c.Endpoint); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return errors.New("blob s3: STORAGE_S3_ENDPOINT must be an absolute http(s) URL without credentials")
	}
	if p := strings.Trim(c.KeyPrefix, "/"); p != "" && ValidateKey(p) != nil {
		return fmt.Errorf("blob s3: STORAGE_S3_KEY_PREFIX %q: expected segments of [A-Za-z0-9._-] separated by /", c.KeyPrefix)
	}
	return nil
}

// ObjectKey is the object in the bucket that holds key: "<KeyPrefix>/<key>", or key itself
// without a prefix. Whoever writes into the bucket past the driver (the LiveKit egress uploads
// meeting recordings, ADR-0025) puts an object here so that Get(key) finds it.
func (c S3Config) ObjectKey(key string) string {
	if p := strings.Trim(c.KeyPrefix, "/"); p != "" {
		return p + "/" + key
	}
	return key
}

// Upload tuning: parts of the S3 minimum size, two sent in parallel. The uploader reads one
// more part ahead, so an upload keeps at most s3PartSize*(s3Concurrency+2) bytes in memory.
const (
	s3PartSize    = manager.MinUploadPartSize
	s3Concurrency = 2
	// A failed multipart upload is aborted even when the request's context is gone: its parts
	// would stay stored (and billed) without ever becoming an object.
	s3AbortTimeout = 30 * time.Second
	// Bucket check at startup.
	s3CheckTimeout = 10 * time.Second
	// Wait for response headers once a request (with its body) is sent.
	s3ResponseTimeout = time.Minute
)

// s3API is the part of *s3.Client the driver uses (a fake in unit tests).
type s3API interface {
	manager.UploadAPIClient
	HeadBucket(context.Context, *s3.HeadBucketInput, ...func(*s3.Options)) (*s3.HeadBucketOutput, error)
	HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	DeleteObject(context.Context, *s3.DeleteObjectInput, ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
}

// S3 stores blobs as objects in an S3-compatible bucket (Yandex Object Storage, Garage, Ceph
// RGW, AWS): one object per key, under the optional key prefix. An object becomes visible
// only when its PutObject or CompleteMultipartUpload succeeds, which gives Put's atomicity.
type S3 struct {
	api    s3API
	up     *manager.Uploader //nolint:staticcheck // SA1019: see newS3
	bucket string
	keys   S3Config // only KeyPrefix: maps keys to objects (ObjectKey)
}

// NewS3 creates the driver with static credentials and checks the bucket (HeadBucket).
func NewS3(ctx context.Context, cfg S3Config) (*S3, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	client := s3.New(s3.Options{
		Region:       cfg.Region,
		BaseEndpoint: aws.String(cfg.Endpoint),
		UsePathStyle: cfg.ForcePathStyle,
		Credentials:  credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, ""),
		// A store that accepts a request and then stalls must not hold uploads and downloads
		// until their clients give up.
		HTTPClient: awshttp.NewBuildableClient().WithTransportOptions(func(t *http.Transport) {
			t.ResponseHeaderTimeout = s3ResponseTimeout
		}),
		// Newer SDKs add CRC32 checksums to every upload and ask for them on download; not all
		// S3-compatible stores accept that, so only where an operation requires it.
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
	})
	s := newS3(client, cfg)
	cctx, cancel := context.WithTimeout(ctx, s3CheckTimeout)
	defer cancel()
	if _, err := client.HeadBucket(cctx, &s3.HeadBucketInput{Bucket: &s.bucket}); err != nil {
		return nil, fmt.Errorf("blob s3: bucket %q at %s: %w", cfg.Bucket, cfg.Endpoint, err)
	}
	return s, nil
}

// newS3 wires the driver to api without any network call.
//
// The uploader of feature/s3/manager is deprecated in favour of feature/s3/transfermanager,
// which is still v0 (unstable API); the manager is kept until that one reaches v1.
func newS3(api s3API, cfg S3Config) *S3 {
	s := &S3{api: api, bucket: cfg.Bucket, keys: S3Config{KeyPrefix: cfg.KeyPrefix}}
	s.up = manager.NewUploader(api, func(u *manager.Uploader) { //nolint:staticcheck // SA1019: see above
		u.PartSize = s3PartSize
		u.Concurrency = s3Concurrency
		u.LeavePartsOnError = true // Put aborts with a context that outlives the request
		u.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
	})
	return s
}

func (s *S3) objectKey(key string) (string, error) {
	if err := ValidateKey(key); err != nil {
		return "", err
	}
	return s.keys.ObjectKey(key), nil
}

// Put implements Store. Input that fits one part goes up as a single PutObject, larger input
// as a multipart upload read part by part (never the whole input in memory). A read error or
// a size mismatch stops the upload before it completes, so no object is created or replaced.
func (s *S3) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	k, err := s.objectKey(key)
	if err != nil {
		return err
	}
	body := io.Reader(ctxReader{ctx, r})
	if size >= 0 {
		body = &sizeReader{r: io.LimitReader(body, size+1), size: size} // one extra byte detects oversize input
	}
	in := &s3.PutObjectInput{Bucket: &s.bucket, Key: &k, Body: body}
	if contentType != "" {
		in.ContentType = &contentType
	}
	_, err = s.up.Upload(ctx, in) //nolint:staticcheck // SA1019: see newS3
	if err == nil {
		return nil
	}
	var mf manager.MultiUploadFailure
	if errors.As(err, &mf) && mf.UploadID() != "" {
		s.abort(ctx, k, mf.UploadID())
	}
	if errors.Is(err, ErrSizeMismatch) {
		return ErrSizeMismatch
	}
	return fmt.Errorf("blob s3: put: %w", err)
}

func (s *S3) abort(ctx context.Context, key, uploadID string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s3AbortTimeout)
	defer cancel()
	_, err := s.api.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{Bucket: &s.bucket, Key: &key, UploadId: &uploadID})
	if err != nil && !hasCode(err, "NoSuchUpload") {
		slog.WarnContext(ctx, "blob s3: abort multipart upload", "key", key, "upload_id", uploadID, "err", err)
	}
}

// sizeReader enforces Put's declared size while the upload reads: ErrSizeMismatch past the
// declared end (r is limited to size+1 bytes) or when the input ends short.
type sizeReader struct {
	r    io.Reader
	n    int64
	size int64
}

func (s *sizeReader) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	s.n += int64(n)
	if s.n > s.size || (err == io.EOF && s.n < s.size) {
		return n, ErrSizeMismatch
	}
	return n, err
}

// Get implements Store. It reads only the metadata (HeadObject); the bytes come on the first
// Read, from a GetObject ranged at the current offset, so a Seek before reading (Range
// requests in http.ServeContent) never downloads the object from its start.
func (s *S3) Get(ctx context.Context, key string) (ReadSeekCloser, Meta, error) {
	k, err := s.objectKey(key)
	if err != nil {
		return nil, Meta{}, err
	}
	out, err := s.head(ctx, k)
	if err != nil {
		return nil, Meta{}, err
	}
	m := headMeta(out)
	return &s3Reader{ctx: ctx, s: s, key: k, etag: aws.ToString(out.ETag), size: m.Size}, m, nil
}

// Stat implements Store.
func (s *S3) Stat(ctx context.Context, key string) (Meta, error) {
	k, err := s.objectKey(key)
	if err != nil {
		return Meta{}, err
	}
	out, err := s.head(ctx, k)
	if err != nil {
		return Meta{}, err
	}
	return headMeta(out), nil
}

// Delete implements Store.
func (s *S3) Delete(ctx context.Context, key string) error {
	k, err := s.objectKey(key)
	if err != nil {
		return err
	}
	if _, err := s.api.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &s.bucket, Key: &k}); err != nil && !isNotFound(err) {
		return fmt.Errorf("blob s3: delete: %w", err)
	}
	return nil
}

func (s *S3) head(ctx context.Context, k string) (*s3.HeadObjectOutput, error) {
	out, err := s.api.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &s.bucket, Key: &k})
	if isNotFound(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("blob s3: head: %w", err)
	}
	return out, nil
}

func headMeta(out *s3.HeadObjectOutput) Meta {
	return Meta{Size: aws.ToInt64(out.ContentLength), ModTime: aws.ToTime(out.LastModified), ContentType: aws.ToString(out.ContentType)}
}

// isNotFound reports a missing object: NoSuchKey from GetObject, a bodiless 404 (NotFound)
// from HeadObject. A missing bucket fails NewS3 already.
func isNotFound(err error) bool {
	return hasCode(err, "NoSuchKey") || hasCode(err, "NotFound")
}

func hasCode(err error, code string) bool {
	var ae smithy.APIError
	return errors.As(err, &ae) && ae.ErrorCode() == code
}

// s3Reader reads an object lazily: the first Read after Get or after a Seek to another offset
// opens GetObject with Range "bytes=<offset>-" and later Reads continue that response. Every
// request is conditional on the ETag seen by Get, so an object replaced meanwhile fails the
// read instead of mixing two versions.
type s3Reader struct {
	ctx    context.Context
	s      *S3
	key    string
	etag   string
	size   int64
	off    int64         // offset of the next Read
	body   io.ReadCloser // open response positioned at off; nil if none
	closed bool
}

func (r *s3Reader) Read(p []byte) (int, error) {
	if r.closed {
		return 0, fs.ErrClosed
	}
	if r.off >= r.size {
		return 0, io.EOF
	}
	if r.body == nil {
		if err := r.open(); err != nil {
			return 0, err
		}
	}
	n, err := r.body.Read(p)
	r.off += int64(n)
	if err != nil {
		r.drop() // the next Read reopens at r.off
		if err == io.EOF && r.off < r.size {
			err = io.ErrUnexpectedEOF
		}
	}
	return n, err
}

func (r *s3Reader) open() error {
	in := &s3.GetObjectInput{Bucket: &r.s.bucket, Key: &r.key}
	if r.etag != "" {
		in.IfMatch = &r.etag
	}
	from := strconv.FormatInt(r.off, 10)
	if r.off > 0 {
		in.Range = aws.String("bytes=" + from + "-")
	}
	out, err := r.s.api.GetObject(r.ctx, in)
	if isNotFound(err) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("blob s3: get: %w", err)
	}
	if in.Range != nil && !strings.HasPrefix(aws.ToString(out.ContentRange), "bytes "+from+"-") {
		_ = out.Body.Close() // a store that ignores Range would serve the wrong bytes
		return fmt.Errorf("blob s3: get: Range not honoured (Content-Range %q)", aws.ToString(out.ContentRange))
	}
	r.body = out.Body
	return nil
}

func (r *s3Reader) Seek(offset int64, whence int) (int64, error) {
	if r.closed {
		return 0, fs.ErrClosed
	}
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		offset += r.off
	case io.SeekEnd:
		offset += r.size
	default:
		return 0, errors.New("blob s3: seek: invalid whence")
	}
	if offset < 0 {
		return 0, errors.New("blob s3: seek: negative position")
	}
	if offset != r.off {
		r.drop()
		r.off = offset
	}
	return offset, nil
}

func (r *s3Reader) Close() error {
	r.drop()
	r.closed = true
	return nil
}

func (r *s3Reader) drop() {
	if r.body != nil {
		_ = r.body.Close()
		r.body = nil
	}
}
