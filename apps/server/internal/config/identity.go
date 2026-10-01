package config

import (
	"fmt"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
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
	return nil
}
