package config

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"strings"
	"testing"
)

func TestIdentityOperatorConfigurationFailsClosed(t *testing.T) {
	empty := &Config{}
	if settings, err := empty.IdentitySettings(); err != nil || settings != nil {
		t.Fatal("unconfigured legacy installation must remain explicit")
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	aes := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{19}, 32))
	signing, _ := json.Marshal(map[string]string{"active": string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))})
	cfg := Config{IdentityPublicOrigin: "https://identity.example.com", IdentityEncryptionKeys: fmt.Sprintf(`{"active":%q}`, aes), IdentityEncryptionActiveKID: "active", OAuthSigningKeys: string(signing), OAuthSigningActiveKID: "active", JWTSecret: "local-api-separate-secret"} //nolint:gosec // Non-secret unit fixture, deliberately distinct from the identity key.
	if settings, err := cfg.IdentitySettings(); err != nil || settings == nil {
		t.Fatalf("valid configuration: %v", err)
	}
	for _, tc := range []struct {
		name   string
		change func(*Config)
	}{
		{"partial", func(c *Config) { c.OAuthSigningKeys = "" }},
		{"non-HTTPS origin", func(c *Config) { c.IdentityPublicOrigin = "http://identity.example.com" }},
		{"origin path", func(c *Config) { c.IdentityPublicOrigin = "https://identity.example.com/poison" }},
		{"missing active encryption", func(c *Config) { c.IdentityEncryptionActiveKID = "absent" }},
		{"missing active signing", func(c *Config) { c.OAuthSigningActiveKID = "absent" }},
		{"JWT key reuse", func(c *Config) { c.JWTSecret = string(bytes.Repeat([]byte{19}, 32)) }},
		{"duplicate encryption KID", func(c *Config) { c.IdentityEncryptionKeys = fmt.Sprintf(`{"active":%q,"active":%q}`, aes, aes) }},
		{"duplicate signing KID", func(c *Config) { c.OAuthSigningKeys = `{"active":"sensitive-private-key","active":"another"}` }},
		{"invalid endpoint CA", func(c *Config) {
			c.IdentityEndpoints = `[{"url":"https://issuer.example/token","ca_pem":"sensitive-private-key"}]`
		}},
		{"loopback LDAP override", func(c *Config) { c.IdentityDirectoryHosts = `[{"host":"ldap.example","networks":["127.0.0.0/8"]}]` }},
		{"duplicate endpoint", func(c *Config) {
			c.IdentityEndpoints = `[{"url":"https://issuer.example/token"},{"url":"https://issuer.example/token"}]`
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := cfg
			tc.change(&bad)
			settings, err := bad.IdentitySettings()
			if err == nil || settings != nil {
				t.Fatal("unsafe/ambiguous configuration accepted")
			}
			if strings.Contains(err.Error(), "sensitive-private-key") || strings.Contains(err.Error(), aes) {
				t.Fatal("operator configuration error disclosed key material")
			}
		})
	}
}
