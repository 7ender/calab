package identitycrypto

import (
	"bytes"
	"errors"
	"github.com/google/uuid"
	"testing"
)

func TestEnvelopeBindingRotationAndTamper(t *testing.T) {
	oldKey, newKey := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	old, err := New("old", map[string][]byte{"old": oldKey})
	if err != nil {
		t.Fatal(err)
	}
	binding := Binding{Purpose: "oidc-client-secret", WorkspaceID: uuid.New(), RecordID: uuid.New(), Version: 1}
	box, err := old.Seal(binding, []byte("canary-secret"))
	if err != nil {
		t.Fatal(err)
	}
	again, err := old.Seal(binding, []byte("canary-secret"))
	if err != nil || bytes.Equal(box, again) {
		t.Fatal("nonce reused")
	}
	rotated, err := New("new", map[string][]byte{"new": newKey, "old": oldKey})
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := rotated.Open(binding, box)
	if err != nil || string(plaintext) != "canary-secret" {
		t.Fatalf("rotation/restore failed %v", err)
	}
	onlyNew, err := New("new", map[string][]byte{"new": newKey})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = onlyNew.Open(binding, box); !errors.Is(err, ErrInvalidBox) {
		t.Fatal("retired key accepted")
	}
	mutations := []Binding{binding, binding, binding, binding}
	mutations[0].Purpose = "ldap-bind-secret"
	mutations[1].WorkspaceID = uuid.New()
	mutations[2].RecordID = uuid.New()
	mutations[3].Version++
	for _, b := range mutations {
		if _, err = rotated.Open(b, box); !errors.Is(err, ErrInvalidBox) {
			t.Fatal("AAD substitution accepted")
		}
	}
	for i := range box {
		damaged := append([]byte(nil), box...)
		damaged[i] ^= 1
		if _, err = rotated.Open(binding, damaged); !errors.Is(err, ErrInvalidBox) {
			t.Fatalf("tampered byte %d accepted", i)
		}
	}
	for i := 0; i < len(box); i++ {
		if _, err = rotated.Open(binding, box[:i]); !errors.Is(err, ErrInvalidBox) {
			t.Fatalf("truncation %d accepted", i)
		}
	}
	oldKey[0] = 99
	if _, err = old.Open(binding, box); err != nil {
		t.Fatal("caller mutated keyring")
	}
}
func TestKeyringAndPayloadBounds(t *testing.T) {
	for _, keys := range []map[string][]byte{nil, {"active": make([]byte, 31)}, {"different": make([]byte, 32)}, {"": make([]byte, 32)}} {
		if _, err := New("active", keys); err == nil {
			t.Fatal("invalid keyring accepted")
		}
	}
	ring, err := New("active", map[string][]byte{"active": make([]byte, 32)})
	if err != nil {
		t.Fatal(err)
	}
	binding := Binding{Purpose: "test", WorkspaceID: uuid.New(), RecordID: uuid.New(), Version: 1}
	if _, err = ring.Seal(binding, make([]byte, maxPayload+1)); err == nil {
		t.Fatal("unbounded payload accepted")
	}
	binding.WorkspaceID = uuid.Nil
	if _, err = ring.Seal(binding, []byte("secret")); err == nil {
		t.Fatal("missing scope accepted")
	}
}
func TestRandomSecretsAndPKCE(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		secret, err := Secret()
		if err != nil || len(secret) != 43 || seen[secret] {
			t.Fatal("invalid random secret")
		}
		seen[secret] = true
		if !EqualHash(secret, Hash(secret)) || EqualHash(secret+"x", Hash(secret)) || EqualHash(secret, []byte{}) {
			t.Fatal("secret hash comparison")
		}
	}
	challenge, err := S256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
	if err != nil || challenge != "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" {
		t.Fatal("RFC7636 vector failed")
	}
	for _, verifier := range []string{"short", string(bytes.Repeat([]byte{'A'}, 129)), string(bytes.Repeat([]byte{'/'}, 43))} {
		if _, err := S256(verifier); err == nil {
			t.Fatal("invalid verifier accepted")
		}
	}
}
