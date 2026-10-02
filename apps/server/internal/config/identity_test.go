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

	"github.com/google/uuid"
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

// Operator private-network allowlists reach a private network for whichever workspace names
// the host: in the cloud edition every entry with private networks must be bound to exact
// workspaces, and a binding applies only to those workspaces.
func TestIdentityOperatorAllowlistsAreWorkspaceBound(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	aes := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{23}, 32))
	signing, _ := json.Marshal(map[string]string{"active": string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))})
	base := Config{IdentityPublicOrigin: "https://identity.example.com", IdentityEncryptionKeys: fmt.Sprintf(`{"active":%q}`, aes), IdentityEncryptionActiveKID: "active", OAuthSigningKeys: string(signing), OAuthSigningActiveKID: "active", JWTSecret: "local-api-separate-secret"} //nolint:gosec // Non-secret unit fixture.
	a, b := uuid.New(), uuid.New()
	unboundHost := `[{"host":"ldap.corp.example","networks":["10.0.0.0/8"]}]`
	unboundEndpoint := `[{"url":"https://idp.corp.example/token","private_cidrs":["10.1.0.0/16"]}]`
	for _, tc := range []struct {
		name, edition, hosts, endpoints string
		ok                              bool
	}{
		{"cloud unbound host", "", unboundHost, "", false},
		{"cloud explicit unbound host", "cloud", unboundHost, "", false},
		{"cloud unbound private endpoint", "cloud", "", unboundEndpoint, false},
		{"cloud unbound public pin", "cloud", "", `[{"url":"https://idp.example/token","approved_cidrs":["203.0.113.0/24"]}]`, true},
		{"cloud bound host", "cloud", `[{"host":"ldap.corp.example","networks":["10.0.0.0/8"],"workspace_ids":["` + a.String() + `"]}]`, "", true},
		{"cloud bound endpoint", "cloud", "", `[{"url":"https://idp.corp.example/token","private_cidrs":["10.1.0.0/16"],"workspace_ids":["` + a.String() + `"]}]`, true},
		{"bad workspace id", "cloud", `[{"host":"ldap.corp.example","networks":["10.0.0.0/8"],"workspace_ids":["all"]}]`, "", false},
		{"duplicate workspace id", "cloud", `[{"host":"ldap.corp.example","networks":["10.0.0.0/8"],"workspace_ids":["` + a.String() + `","` + a.String() + `"]}]`, "", false},
		{"on-prem unbound", "enterprise", unboundHost, unboundEndpoint, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := base
			c.IdentityEdition, c.IdentityDirectoryHosts, c.IdentityEndpoints = tc.edition, tc.hosts, tc.endpoints
			settings, err := c.IdentitySettings()
			if (err == nil) != tc.ok {
				t.Fatalf("accepted=%v: %v", err == nil, err)
			}
			if !tc.ok && !strings.Contains(err.Error(), "workspace_ids") && tc.name != "bad workspace id" {
				t.Fatalf("unclear error: %v", err)
			}
			_ = settings
		})
	}
	c := base
	c.IdentityEndpoints = `[{"url":"https://idp.corp.example/token","private_cidrs":["10.1.0.0/16"],"workspace_ids":["` + a.String() + `"]}]`
	settings, err := c.IdentitySettings()
	if err != nil {
		t.Fatal(err)
	}
	if ep, ok := settings.EndpointFor(a, "https://idp.corp.example/token"); !ok || len(ep.PrivateCIDRs) != 1 {
		t.Fatal("bound workspace lost its override")
	}
	if _, ok := settings.EndpointFor(b, "https://idp.corp.example/token"); ok {
		t.Fatal("override applied to another workspace")
	}
}
