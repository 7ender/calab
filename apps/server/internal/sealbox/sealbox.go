// Package sealbox encrypts small secrets at rest (mail outbox parameters, integration
// tokens) with AES-256-GCM under a key derived from the server secret (JWT_SECRET) and a
// purpose label, so a value sealed for one purpose cannot be opened as another's.
package sealbox

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
)

// Box seals and opens values for one purpose.
type Box struct{ aead cipher.AEAD }

// New derives the key sha256(purpose || 0x00 || secret). purpose names the data and a
// version, e.g. "calaba/mail-outbox/v1"; changing it (or the secret) makes old values
// unreadable.
func New(purpose string, secret []byte) *Box {
	sum := sha256.Sum256(append([]byte(purpose+"\x00"), secret...))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		panic(err) // 32-byte key: cannot fail
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
	return &Box{aead: aead}
}

// Seal encrypts plain: nonce || ciphertext.
func (b *Box) Seal(plain []byte) ([]byte, error) {
	nonce := make([]byte, b.aead.NonceSize(), b.aead.NonceSize()+len(plain)+b.aead.Overhead())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return b.aead.Seal(nonce, nonce, plain, nil), nil
}

// Open decrypts a value made by Seal.
func (b *Box) Open(sealed []byte) ([]byte, error) {
	n := b.aead.NonceSize()
	if len(sealed) < n {
		return nil, errors.New("sealbox: value too short")
	}
	plain, err := b.aead.Open(nil, sealed[:n], sealed[n:], nil)
	if err != nil {
		return nil, fmt.Errorf("sealbox: open (JWT_SECRET changed?): %w", err)
	}
	return plain, nil
}
