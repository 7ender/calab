package config

import (
	"bytes"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/oauthprovider/signing"
	"github.com/google/uuid"
	"io"
	"net/netip"
	"net/url"
	"strings"
)

// IdentityEntitlements returns trusted positive entitlement configuration. Empty edition
// means the cloud default for manually constructed configurations used by existing tests.
func (c *Config) IdentityEntitlements() identitypolicy.EntitlementConfig {
	edition := c.IdentityEdition
	if edition == "" {
		edition = "cloud"
	}
	ids := map[uuid.UUID]bool{}
	for _, raw := range c.IdentityEnterpriseWorkspaceIDs {
		if id, err := uuid.Parse(raw); err == nil && id != uuid.Nil {
			ids[id] = true
		}
	}
	return identitypolicy.EntitlementConfig{Edition: edition, EnterpriseWorkspaceIDs: ids}
}

func (c *Config) validateIdentity() error {
	if c.IdentityEdition != "" && c.IdentityEdition != "cloud" && c.IdentityEdition != "enterprise" {
		return fmt.Errorf("IDENTITY_EDITION must be cloud or enterprise")
	}
	for _, raw := range c.IdentityEnterpriseWorkspaceIDs {
		if id, err := uuid.Parse(raw); err != nil || id == uuid.Nil {
			return fmt.Errorf("IDENTITY_ENTERPRISE_WORKSPACE_IDS requires exact nonzero UUIDs")
		}
	}
	_, err := c.IdentitySettings()
	return err
}

// IdentitySettings is a validated immutable dependency snapshot of operator configuration.
type IdentitySettings struct {
	Origin           string
	Encryption       *identitycrypto.Keyring
	SigningKeys      []signing.Key
	SigningActiveKID string
	Endpoints        map[string]IdentityEndpoint
	DirectoryHosts   map[string]IdentityDirectoryHost
}

// IdentityDirectoryHost pins a trusted LDAP host to networks and an optional CA.
type IdentityDirectoryHost struct {
	Networks []netip.Prefix
	CAPEM    string
}

// IdentityEndpoint overrides one exact upstream URL using operator network policy.
type IdentityEndpoint struct {
	URL                         string
	ApprovedCIDRs, PrivateCIDRs []netip.Prefix
	RootCAs                     *x509.CertPool
}

func validateIdentityEndpoint(ep IdentityEndpoint) (bool, error) {
	u, err := url.Parse(ep.URL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return false, fmt.Errorf("invalid endpoint")
	}
	for _, network := range append(append([]netip.Prefix{}, ep.ApprovedCIDRs...), ep.PrivateCIDRs...) {
		if !network.IsValid() || network.Addr().IsLoopback() || network.Addr().IsUnspecified() {
			return false, fmt.Errorf("invalid endpoint network")
		}
	}
	return true, nil
}

type identityEndpointJSON struct {
	URL           string         `json:"url"`
	ApprovedCIDRs []netip.Prefix `json:"approved_cidrs"`
	PrivateCIDRs  []netip.Prefix `json:"private_cidrs"`
	CAPEM         string         `json:"ca_pem"`
}
type identityDirectoryJSON struct {
	Host     string         `json:"host"`
	Networks []netip.Prefix `json:"networks"`
	CAPEM    string         `json:"ca_pem"`
}

func (*IdentitySettings) String() string { return "identity settings(redacted)" }

// IdentitySettings returns nil only for the explicit unconfigured legacy installation.
// Any partial configuration fails startup; no secret falls back to JWT_SECRET.
func (c *Config) IdentitySettings() (*IdentitySettings, error) {
	if c.IdentityPublicOrigin == "" && c.IdentityEncryptionKeys == "" && c.IdentityEncryptionActiveKID == "" && c.OAuthSigningKeys == "" && c.OAuthSigningActiveKID == "" && c.IdentityEndpoints == "" && c.IdentityDirectoryHosts == "" {
		return nil, nil
	}
	invalid := func(field string) (*IdentitySettings, error) {
		return nil, fmt.Errorf("invalid identity operator configuration: %s", field)
	}
	u, err := url.Parse(c.IdentityPublicOrigin)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || strings.Contains(c.IdentityPublicOrigin, "#") || u.Opaque != "" {
		return invalid("IDENTITY_PUBLIC_ORIGIN")
	}
	encryption, err := identityKeyMap(c.IdentityEncryptionKeys)
	if err != nil || len(encryption) > 32 {
		return invalid("IDENTITY_ENCRYPTION_KEYS")
	}
	decoded := map[string][]byte{}
	for kid, raw := range encryption {
		key, err := base64.StdEncoding.Strict().DecodeString(raw)
		if err != nil || len(key) != 32 || raw == c.JWTSecret || bytes.Equal(key, []byte(c.JWTSecret)) {
			return invalid("IDENTITY_ENCRYPTION_KEYS")
		}
		decoded[kid] = key
	}
	ring, err := identitycrypto.New(c.IdentityEncryptionActiveKID, decoded)
	if err != nil {
		return invalid("IDENTITY_ENCRYPTION_KEYS")
	}
	pemKeys, err := identityKeyMap(c.OAuthSigningKeys)
	if err != nil {
		return invalid("OAUTH_SIGNING_KEYS")
	}
	signingKeys := make([]signing.Key, 0, len(pemKeys))
	for kid, pem := range pemKeys {
		signingKeys = append(signingKeys, signing.Key{KID: kid, PEM: []byte(pem)})
	}
	if _, err = signing.New(signing.Config{Issuer: c.IdentityPublicOrigin + "/oidc/workspaces/" + uuid.Nil.String(), ActiveKID: c.OAuthSigningActiveKID, Keys: signingKeys}); err != nil {
		return invalid("OAUTH_SIGNING_KEYS")
	}
	out := &IdentitySettings{Origin: c.IdentityPublicOrigin, Encryption: ring, SigningKeys: signingKeys, SigningActiveKID: c.OAuthSigningActiveKID, Endpoints: map[string]IdentityEndpoint{}, DirectoryHosts: map[string]IdentityDirectoryHost{}}
	var endpoints []identityEndpointJSON
	if c.IdentityEndpoints != "" && json.Unmarshal([]byte(c.IdentityEndpoints), &endpoints) != nil {
		return invalid("IDENTITY_ENDPOINTS")
	}
	for _, ep := range endpoints {
		if _, ok := out.Endpoints[ep.URL]; ok {
			return invalid("IDENTITY_ENDPOINTS")
		}
		entry := IdentityEndpoint{URL: ep.URL, ApprovedCIDRs: ep.ApprovedCIDRs, PrivateCIDRs: ep.PrivateCIDRs}
		if ep.CAPEM != "" {
			entry.RootCAs = x509.NewCertPool()
			if !entry.RootCAs.AppendCertsFromPEM([]byte(ep.CAPEM)) {
				return invalid("IDENTITY_ENDPOINTS")
			}
		}
		if _, err := validateIdentityEndpoint(entry); err != nil {
			return invalid("IDENTITY_ENDPOINTS")
		}
		out.Endpoints[ep.URL] = entry
	}
	var hosts []identityDirectoryJSON
	if c.IdentityDirectoryHosts != "" && json.Unmarshal([]byte(c.IdentityDirectoryHosts), &hosts) != nil {
		return invalid("IDENTITY_DIRECTORY_HOSTS")
	}
	for _, host := range hosts {
		if host.Host == "" || host.Host != strings.ToLower(host.Host) || strings.HasSuffix(host.Host, ".") || strings.ContainsAny(host.Host, "/:@ ") || len(host.Networks) == 0 {
			return invalid("IDENTITY_DIRECTORY_HOSTS")
		}
		if _, ok := out.DirectoryHosts[host.Host]; ok {
			return invalid("IDENTITY_DIRECTORY_HOSTS")
		}
		for _, network := range host.Networks {
			if !network.IsValid() || network.Addr().IsLoopback() || network.Addr().IsUnspecified() {
				return invalid("IDENTITY_DIRECTORY_HOSTS")
			}
		}
		if host.CAPEM != "" {
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM([]byte(host.CAPEM)) {
				return invalid("IDENTITY_DIRECTORY_HOSTS")
			}
		}
		out.DirectoryHosts[host.Host] = IdentityDirectoryHost{Networks: host.Networks, CAPEM: host.CAPEM}
	}
	return out, nil
}

// JSON objects silently overwrite duplicate members in encoding/json. A keyring
// must have one unambiguous value per KID, including during staged key rotation.
func identityKeyMap(raw string) (map[string]string, error) {
	decoder := json.NewDecoder(strings.NewReader(raw))
	open, err := decoder.Token()
	if err != nil || open != json.Delim('{') {
		return nil, fmt.Errorf("invalid key map")
	}
	keys := map[string]string{}
	for decoder.More() {
		name, err := decoder.Token()
		if err != nil {
			return nil, fmt.Errorf("invalid key map")
		}
		kid, ok := name.(string)
		if !ok {
			return nil, fmt.Errorf("invalid key map")
		}
		if _, exists := keys[kid]; exists {
			return nil, fmt.Errorf("duplicate key id")
		}
		var value string
		if decoder.Decode(&value) != nil {
			return nil, fmt.Errorf("invalid key map")
		}
		keys[kid] = value
	}
	if closing, err := decoder.Token(); err != nil || closing != json.Delim('}') {
		return nil, fmt.Errorf("invalid key map")
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, fmt.Errorf("invalid key map")
	}
	return keys, nil
}
