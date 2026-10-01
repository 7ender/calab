package blob

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

// fakeS3 is an in-memory bucket with the semantics the driver relies on: objects appear on
// PutObject / CompleteMultipartUpload only, ranged and conditional GetObject, 404 codes as
// the SDK reports them.
type fakeS3 struct {
	mu          sync.Mutex
	objects     map[string]fakeObject
	uploads     map[string]*fakeUpload
	seq         int
	ranges      []string // Range of every GetObject, in order
	ignoreRange bool     // answer ranged GetObject with the whole object, as a broken store would
}

type fakeObject struct {
	data  []byte
	etag  string
	ctype string
	mod   time.Time
}

type fakeUpload struct {
	key, ctype string
	parts      map[int32][]byte
}

func newFakeS3() *fakeS3 {
	return &fakeS3{objects: map[string]fakeObject{}, uploads: map[string]*fakeUpload{}}
}

func (f *fakeS3) store(key string, data []byte, ctype string) *string {
	f.seq++
	etag := `"` + strconv.Itoa(f.seq) + `"`
	f.objects[key] = fakeObject{data: data, etag: etag, ctype: ctype, mod: time.Now()}
	return &etag
}

func (f *fakeS3) pending() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.uploads)
}

func apiErr(code string) error { return &smithy.GenericAPIError{Code: code, Message: code} }

func (f *fakeS3) PutObject(_ context.Context, in *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	data, err := io.ReadAll(in.Body)
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return &s3.PutObjectOutput{ETag: f.store(*in.Key, data, aws.ToString(in.ContentType))}, nil
}

func (f *fakeS3) CreateMultipartUpload(_ context.Context, in *s3.CreateMultipartUploadInput, _ ...func(*s3.Options)) (*s3.CreateMultipartUploadOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seq++
	id := "upload-" + strconv.Itoa(f.seq)
	f.uploads[id] = &fakeUpload{key: *in.Key, ctype: aws.ToString(in.ContentType), parts: map[int32][]byte{}}
	return &s3.CreateMultipartUploadOutput{UploadId: &id}, nil
}

func (f *fakeS3) UploadPart(_ context.Context, in *s3.UploadPartInput, _ ...func(*s3.Options)) (*s3.UploadPartOutput, error) {
	data, err := io.ReadAll(in.Body)
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	u, ok := f.uploads[*in.UploadId]
	if !ok {
		return nil, apiErr("NoSuchUpload")
	}
	u.parts[*in.PartNumber] = data
	return &s3.UploadPartOutput{ETag: aws.String("part-" + strconv.Itoa(int(*in.PartNumber)))}, nil
}

func (f *fakeS3) CompleteMultipartUpload(_ context.Context, in *s3.CompleteMultipartUploadInput, _ ...func(*s3.Options)) (*s3.CompleteMultipartUploadOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	u, ok := f.uploads[*in.UploadId]
	if !ok {
		return nil, apiErr("NoSuchUpload")
	}
	var data []byte
	for _, p := range in.MultipartUpload.Parts {
		b, ok := u.parts[*p.PartNumber]
		if !ok {
			return nil, apiErr("InvalidPart")
		}
		data = append(data, b...)
	}
	delete(f.uploads, *in.UploadId)
	return &s3.CompleteMultipartUploadOutput{ETag: f.store(u.key, data, u.ctype)}, nil
}

func (f *fakeS3) AbortMultipartUpload(_ context.Context, in *s3.AbortMultipartUploadInput, _ ...func(*s3.Options)) (*s3.AbortMultipartUploadOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.uploads[*in.UploadId]; !ok {
		return nil, apiErr("NoSuchUpload")
	}
	delete(f.uploads, *in.UploadId)
	return &s3.AbortMultipartUploadOutput{}, nil
}

func (f *fakeS3) HeadBucket(context.Context, *s3.HeadBucketInput, ...func(*s3.Options)) (*s3.HeadBucketOutput, error) {
	return &s3.HeadBucketOutput{}, nil
}

func (f *fakeS3) HeadObject(_ context.Context, in *s3.HeadObjectInput, _ ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o, ok := f.objects[*in.Key]
	if !ok {
		return nil, &types.NotFound{}
	}
	return &s3.HeadObjectOutput{ContentLength: aws.Int64(int64(len(o.data))), ETag: &o.etag, LastModified: &o.mod, ContentType: &o.ctype}, nil
}

func (f *fakeS3) GetObject(_ context.Context, in *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ranges = append(f.ranges, aws.ToString(in.Range))
	o, ok := f.objects[*in.Key]
	if !ok {
		return nil, &types.NoSuchKey{}
	}
	if in.IfMatch != nil && *in.IfMatch != o.etag {
		return nil, apiErr("PreconditionFailed")
	}
	out := &s3.GetObjectOutput{ETag: &o.etag}
	data := o.data
	if r := aws.ToString(in.Range); r != "" && !f.ignoreRange {
		from, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(r, "bytes="), "-"))
		if err != nil || from >= len(data) {
			return nil, apiErr("InvalidRange")
		}
		out.ContentRange = aws.String(fmt.Sprintf("bytes %d-%d/%d", from, len(data)-1, len(data)))
		data = data[from:]
	}
	out.Body, out.ContentLength = io.NopCloser(bytes.NewReader(data)), aws.Int64(int64(len(data)))
	return out, nil
}

func (f *fakeS3) DeleteObject(_ context.Context, in *s3.DeleteObjectInput, _ ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.objects, *in.Key)
	return &s3.DeleteObjectOutput{}, nil
}

func TestS3ContractFake(t *testing.T) {
	f := newFakeS3()
	s := newS3(f, S3Config{Bucket: "b", KeyPrefix: "/calab/test/"})
	testStoreContract(t, s)
	if n := f.pending(); n != 0 {
		t.Fatalf("%d multipart uploads left behind", n)
	}
	for k := range f.objects {
		if !strings.HasPrefix(k, "calab/test/") {
			t.Fatalf("object %q outside the key prefix", k)
		}
	}
}

// An object written into the bucket past the driver (the egress uploads recordings) under
// ObjectKey(key) is the one the driver reads, stats and deletes as key.
func TestS3ObjectKey(t *testing.T) {
	ctx := context.Background()
	for prefix, under := range map[string]string{"": "", "calab": "calab/", "/calab/files/": "calab/files/"} {
		f := newFakeS3()
		cfg := S3Config{Bucket: "b", KeyPrefix: prefix}
		s := newS3(f, cfg)
		key := newKey() + ".mp4"
		if got, want := cfg.ObjectKey(key), under+key; got != want {
			t.Fatalf("prefix %q: ObjectKey = %q, want %q", prefix, got, want)
		}
		f.store(cfg.ObjectKey(key), []byte("recorded"), "video/mp4")
		if m, err := s.Stat(ctx, key); err != nil || m.Size != 8 {
			t.Fatalf("prefix %q: stat %+v %v", prefix, m, err)
		}
		if got := readAll(t, s, key); string(got) != "recorded" {
			t.Fatalf("prefix %q: read %q", prefix, got)
		}
		if err := s.Delete(ctx, key); err != nil || len(f.objects) != 0 {
			t.Fatalf("prefix %q: delete %v, left %d", prefix, err, len(f.objects))
		}
	}
}

func TestS3ContentType(t *testing.T) {
	s := newS3(newFakeS3(), S3Config{Bucket: "b"})
	ctx := context.Background()
	for _, n := range []int{10, 6 << 20} { // single PutObject and multipart
		key := newKey()
		if err := s.Put(ctx, key, bytes.NewReader(make([]byte, n)), int64(n), "image/webp"); err != nil {
			t.Fatal(err)
		}
		if m, err := s.Stat(ctx, key); err != nil || m.ContentType != "image/webp" {
			t.Fatalf("%d bytes: %+v %v", n, m, err)
		}
	}
}

// Reading is lazy and ranged: Get and Seek make no GetObject, reads start at the offset.
func TestS3ReaderRanges(t *testing.T) {
	f := newFakeS3()
	s := newS3(f, S3Config{Bucket: "b"})
	ctx := context.Background()
	key := newKey()
	mustPut(t, s, key, []byte("0123456789"), 10)
	r, _, err := s.Get(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close() }()
	if _, err := r.Seek(0, io.SeekEnd); err != nil { // http.ServeContent: size, then back
		t.Fatal(err)
	}
	if _, err := r.Seek(4, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if len(f.ranges) != 0 {
		t.Fatalf("GetObject before the first Read: %q", f.ranges)
	}
	b := make([]byte, 3)
	if _, err := io.ReadFull(r, b); err != nil || string(b) != "456" {
		t.Fatalf("%q %v", b, err)
	}
	if _, err := io.ReadFull(r, b); err != nil || string(b) != "789" { // same response
		t.Fatalf("%q %v", b, err)
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(r, b); err != nil || string(b) != "012" {
		t.Fatalf("%q %v", b, err)
	}
	if want := []string{"bytes=4-", ""}; !slices.Equal(f.ranges, want) {
		t.Fatalf("GetObject ranges %q, want %q", f.ranges, want)
	}
	// A store that ignores Range fails the read rather than serving bytes from offset 0.
	f.ignoreRange = true
	if _, err := r.Seek(5, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if n, err := r.Read(b); n != 0 || err == nil || !strings.Contains(err.Error(), "Range not honoured") {
		t.Fatalf("ignored Range: %d %v", n, err)
	}
}

// A reader never mixes two versions of an object: replaced after Get, it fails.
func TestS3ReaderPinsVersion(t *testing.T) {
	s := newS3(newFakeS3(), S3Config{Bucket: "b"})
	ctx := context.Background()
	key := newKey()
	mustPut(t, s, key, []byte("version 1"), -1)
	r, _, err := s.Get(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close() }()
	mustPut(t, s, key, []byte("version 2"), -1)
	if _, err := io.ReadAll(r); err == nil || !hasCode(err, "PreconditionFailed") {
		t.Fatalf("read of a replaced object: %v", err)
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Seek(1, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(r); !errors.Is(err, ErrNotFound) {
		t.Fatalf("read of a deleted object: %v", err)
	}
}

func TestS3Errors(t *testing.T) {
	for _, c := range []struct {
		err  error
		want bool
	}{
		{&types.NoSuchKey{}, true},
		{&types.NotFound{}, true},
		{fmt.Errorf("op: %w", apiErr("NoSuchKey")), true},
		{apiErr("NoSuchBucket"), false},
		{apiErr("AccessDenied"), false},
		{errors.New("NoSuchKey"), false},
		{nil, false},
	} {
		if got := isNotFound(c.err); got != c.want {
			t.Errorf("isNotFound(%v) = %v", c.err, got)
		}
	}
}

func TestS3ConfigValidate(t *testing.T) {
	ok := S3Config{Endpoint: "https://storage.yandexcloud.net", Region: "ru-central1", Bucket: "b",
		AccessKeyID: "id", SecretAccessKey: "top-secret-value", KeyPrefix: "calab/prod/"}
	if err := ok.validate(); err != nil {
		t.Fatal(err)
	}
	for name, mod := range map[string]func(*S3Config){
		"no endpoint":      func(c *S3Config) { c.Endpoint = "" },
		"no bucket":        func(c *S3Config) { c.Bucket = " " },
		"no region":        func(c *S3Config) { c.Region = "" },
		"no key id":        func(c *S3Config) { c.AccessKeyID = "" },
		"no secret":        func(c *S3Config) { c.SecretAccessKey = "" },
		"relative":         func(c *S3Config) { c.Endpoint = "storage.yandexcloud.net" },
		"ftp":              func(c *S3Config) { c.Endpoint = "ftp://storage.yandexcloud.net" },
		"userinfo":         func(c *S3Config) { c.Endpoint = "https://id:top-secret-value@storage.yandexcloud.net" },
		"prefix traversal": func(c *S3Config) { c.KeyPrefix = "calab/../x" },
		"prefix charset":   func(c *S3Config) { c.KeyPrefix = "calab files" },
	} {
		c := ok
		mod(&c)
		err := c.validate()
		if err == nil {
			t.Errorf("%s: accepted", name)
		} else if strings.Contains(err.Error(), "top-secret-value") {
			t.Errorf("%s: secret in the error: %v", name, err)
		}
	}
	if _, err := NewS3(context.Background(), S3Config{}); err == nil {
		t.Fatal("empty config accepted")
	}
}
