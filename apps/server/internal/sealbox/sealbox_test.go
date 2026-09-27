package sealbox

import (
	"bytes"
	"testing"
)

func TestRoundTripAndPurposeSeparation(t *testing.T) {
	a := New("calaba/test/v1", []byte("secret-secret-secret-secret-secret"))
	s1, err := a.Seal([]byte("token"))
	if err != nil {
		t.Fatal(err)
	}
	s2, _ := a.Seal([]byte("token"))
	if bytes.Equal(s1, s2) {
		t.Fatal("same ciphertext twice: nonce not random")
	}
	if got, err := a.Open(s1); err != nil || string(got) != "token" {
		t.Fatalf("open: %q %v", got, err)
	}
	b := New("calaba/other/v1", []byte("secret-secret-secret-secret-secret"))
	if _, err := b.Open(s1); err == nil {
		t.Fatal("another purpose opened the value")
	}
	if _, err := a.Open([]byte("x")); err == nil {
		t.Fatal("short value accepted")
	}
	s1[len(s1)-1] ^= 1
	if _, err := a.Open(s1); err == nil {
		t.Fatal("tampered value accepted")
	}
}
