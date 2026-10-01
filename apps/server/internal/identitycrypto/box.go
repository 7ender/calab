// Package identitycrypto seals server credentials separately from first-party JWT keys.
package identitycrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

const maxPayload = 1 << 20

// ErrInvalidBox hides parsing, key lookup, and authentication failure details.
var ErrInvalidBox = errors.New("invalid identity credential envelope")

// Binding identifies the purpose, tenant, record, and configuration version of a secret.
type Binding struct {
	Purpose               string
	WorkspaceID, RecordID uuid.UUID
	Version               int64
}

// Keyring is an immutable snapshot of encryption keys with one active writer key.
type Keyring struct {
	active string
	keys   map[string][]byte
}

// New validates and copies an AES-256 keyring; keys come from independent operator env.
func New(active string, keys map[string][]byte) (*Keyring, error) {
	if active == "" || len(keys) == 0 {
		return nil, errors.New("identity encryption keyring is required")
	}
	ring := &Keyring{active: active, keys: make(map[string][]byte, len(keys))}
	for kid, key := range keys {
		if len(kid) == 0 || len(kid) > 64 || strings.ContainsAny(kid, "\x00\r\n") || len(key) != 32 {
			return nil, errors.New("identity encryption keys require bounded IDs and AES-256 keys")
		}
		ring.keys[kid] = append([]byte(nil), key...)
	}
	if ring.keys[active] == nil {
		return nil, errors.New("identity encryption active key is absent")
	}
	return ring, nil
}
func aad(b Binding) ([]byte, error) {
	purposeLength := len(b.Purpose)
	if b.WorkspaceID == uuid.Nil || b.RecordID == uuid.Nil || b.Version < 1 || purposeLength == 0 || purposeLength > 128 {
		return nil, ErrInvalidBox
	}
	out := []byte("calaba/identity/envelope/v1\x00")
	out = append(out, byte(purposeLength))
	out = append(out, []byte(b.Purpose)...)
	out = append(out, b.WorkspaceID[:]...)
	out = append(out, b.RecordID[:]...)
	out = binary.BigEndian.AppendUint64(out, uint64(b.Version))
	return out, nil
}
func aead(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Seal encrypts a bounded payload with a random nonce and the exact binding as AAD.
func (r *Keyring) Seal(b Binding, plaintext []byte) ([]byte, error) {
	if r == nil || len(plaintext) > maxPayload {
		return nil, ErrInvalidBox
	}
	associated, err := aad(b)
	if err != nil {
		return nil, err
	}
	gcm, err := aead(r.keys[r.active])
	if err != nil {
		return nil, ErrInvalidBox
	}
	kidLength := len(r.active)
	if kidLength < 1 || kidLength > 64 {
		return nil, ErrInvalidBox
	}
	header := append([]byte{1, byte(kidLength)}, []byte(r.active)...)
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("identity nonce: %w", err)
	}
	associated = append(associated, header...)
	prefix := append(header, nonce...)
	return gcm.Seal(prefix, nonce, plaintext, associated), nil
}

// Open authenticates an envelope under its original key and exact binding.
func (r *Keyring) Open(b Binding, envelope []byte) ([]byte, error) {
	if r == nil || len(envelope) < 2 || len(envelope) > maxPayload+128 || envelope[0] != 1 {
		return nil, ErrInvalidBox
	}
	kidLen := int(envelope[1])
	if kidLen == 0 || kidLen > 64 || len(envelope) < 2+kidLen {
		return nil, ErrInvalidBox
	}
	header := envelope[:2+kidLen]
	key := r.keys[string(envelope[2:2+kidLen])]
	if key == nil {
		return nil, ErrInvalidBox
	}
	associated, err := aad(b)
	if err != nil {
		return nil, ErrInvalidBox
	}
	associated = append(associated, header...)
	gcm, err := aead(key)
	if err != nil || len(envelope) < len(header)+gcm.NonceSize()+gcm.Overhead() {
		return nil, ErrInvalidBox
	}
	nonce := envelope[len(header) : len(header)+gcm.NonceSize()]
	plaintext, err := gcm.Open(nil, nonce, envelope[len(header)+gcm.NonceSize():], associated)
	if err != nil {
		return nil, ErrInvalidBox
	}
	return plaintext, nil
}

// Secret returns 256 random bits encoded without padding. Hash is for random secrets only.
func Secret() (string, error) {
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes[:]), nil
}

// Hash digests a high-entropy protocol secret; it is not a password hasher.
func Hash(secret string) []byte { sum := sha256.Sum256([]byte(secret)); return sum[:] }

// EqualHash compares a secret digest in constant time.
func EqualHash(secret string, expected []byte) bool {
	return len(expected) == sha256.Size && subtle.ConstantTimeCompare(Hash(secret), expected) == 1
}

// S256 validates an RFC 7636 verifier and returns its SHA-256 challenge.
func S256(verifier string) (string, error) {
	if len(verifier) < 43 || len(verifier) > 128 {
		return "", errors.New("invalid PKCE verifier")
	}
	for _, c := range verifier {
		valid := c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.ContainsRune("-._~", c)
		if !valid {
			return "", errors.New("invalid PKCE verifier")
		}
	}
	return base64.RawURLEncoding.EncodeToString(Hash(verifier)), nil
}
