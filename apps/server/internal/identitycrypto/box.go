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

var ErrInvalidBox = errors.New("invalid identity credential envelope")

type Binding struct {
	Purpose               string
	WorkspaceID, RecordID uuid.UUID
	Version               int64
}
type Keyring struct {
	active string
	keys   map[string][]byte
}

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
	if b.WorkspaceID == uuid.Nil || b.RecordID == uuid.Nil || b.Version < 1 || len(b.Purpose) == 0 || len(b.Purpose) > 128 {
		return nil, ErrInvalidBox
	}
	out := []byte("calaba/identity/envelope/v1\x00")
	out = append(out, byte(len(b.Purpose)))
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
	header := append([]byte{1, byte(len(r.active))}, []byte(r.active)...)
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("identity nonce: %w", err)
	}
	associated = append(associated, header...)
	prefix := append(header, nonce...)
	return gcm.Seal(prefix, nonce, plaintext, associated), nil
}
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
func Hash(secret string) []byte { sum := sha256.Sum256([]byte(secret)); return sum[:] }
func EqualHash(secret string, expected []byte) bool {
	return len(expected) == sha256.Size && subtle.ConstantTimeCompare(Hash(secret), expected) == 1
}
func S256(verifier string) (string, error) {
	if len(verifier) < 43 || len(verifier) > 128 {
		return "", errors.New("invalid PKCE verifier")
	}
	for _, c := range verifier {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.ContainsRune("-._~", c)) {
			return "", errors.New("invalid PKCE verifier")
		}
	}
	return base64.RawURLEncoding.EncodeToString(Hash(verifier)), nil
}
