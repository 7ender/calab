package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// argon2id parameters: OWASP 2023 profile (19 MiB, t=2, p=1). Memory-light on purpose:
// the server targets < 50 MB RSS; concurrency is capped by hashSlots.
const (
	argonMemoryKiB = 19 * 1024
	argonTime      = 2
	argonThreads   = 1
	argonKeyLen    = 32
	argonSaltLen   = 16
)

// At most 4 hashes run at once (≈ 76 MiB peak), the rest wait (or give up with ctx).
var hashSlots = make(chan struct{}, 4)

func acquire(ctx context.Context) error {
	select {
	case hashSlots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func release() { <-hashSlots }

var b64 = base64.RawStdEncoding

// HashPassword returns a PHC-formatted argon2id hash.
func HashPassword(ctx context.Context, password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	if err := acquire(ctx); err != nil {
		return "", err
	}
	defer release()
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemoryKiB, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemoryKiB, argonTime, argonThreads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

var errBadHash = errors.New("auth: malformed password hash")

// VerifyPassword checks password against a PHC argon2id hash (parameters are read from it).
func VerifyPassword(ctx context.Context, password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errBadHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errBadHash
	}
	var mem, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &mem, &t, &p); err != nil || mem == 0 || mem > 1<<20 || t == 0 || t > 16 || p == 0 {
		return false, errBadHash
	}
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, errBadHash
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil || len(want) == 0 || len(want) > 128 {
		return false, errBadHash
	}
	if err := acquire(ctx); err != nil {
		return false, err
	}
	defer release()
	got := argon2.IDKey([]byte(password), salt, t, mem, p, uint32(len(want))) //nolint:gosec // len checked above
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// dummyHash is verified against when the user does not exist, so that login timing does
// not reveal whether an email is registered.
var dummyHash = func() string {
	h, err := HashPassword(context.Background(), "calaba-dummy-password")
	if err != nil {
		panic(err)
	}
	return h
}()
