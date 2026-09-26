// Package config loads server configuration from environment variables only.
package config

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/caarlos0/env/v11"
)

// RegistrationMode controls who may create an account.
type RegistrationMode string

// Registration modes (REGISTRATION_MODE).
const (
	RegistrationOpen   RegistrationMode = "open"
	RegistrationInvite RegistrationMode = "invite"
)

// Config is the full server configuration. See apps/server/README.md for the list.
type Config struct {
	HTTPAddr        string `env:"HTTP_ADDR" envDefault:"127.0.0.1:3000"`
	PublicAppURL    string `env:"PUBLIC_APP_URL" envDefault:"http://localhost:3000"`
	PublicAppURLAlt string `env:"PUBLIC_APP_URL_ALT"` // optional second domain of the web client (compatibility)
	// All origins the web client is served from, comma-separated (app host, aliases). The
	// CSRF / gateway Origin checks accept these plus PUBLIC_APP_URL and PUBLIC_APP_URL_ALT;
	// PUBLIC_APP_URL stays the primary one (links).
	PublicAppURLs []string `env:"PUBLIC_APP_URLS" envSeparator:","`
	LogLevel      string   `env:"LOG_LEVEL" envDefault:"info"`

	DatabaseURL string `env:"DATABASE_URL,required"`
	RedisURL    string `env:"REDIS_URL,required"`

	JWTSecret       string        `env:"JWT_SECRET,required"`
	AccessTokenTTL  time.Duration `env:"ACCESS_TOKEN_TTL" envDefault:"15m"`
	RefreshTokenTTL time.Duration `env:"REFRESH_TOKEN_TTL" envDefault:"720h"`

	RegistrationMode RegistrationMode `env:"REGISTRATION_MODE" envDefault:"invite"`

	// Login/register rate limit per client IP (token bucket in Redis).
	AuthRateBurst     int     `env:"AUTH_RATE_BURST" envDefault:"10"`
	AuthRatePerMinute float64 `env:"AUTH_RATE_PER_MINUTE" envDefault:"10"`

	// Login attempts per account (email) per 15 minutes, from any IP.
	LoginAccountBurst int `env:"LOGIN_ACCOUNT_ATTEMPTS" envDefault:"10"`

	// Abuse limits (disk is shared with other tenants of the host).
	MaxWorkspacesPerUser       int   `env:"MAX_WORKSPACES_PER_USER" envDefault:"5"`
	WorkspaceCreatesPerHour    int   `env:"WORKSPACE_CREATES_PER_HOUR" envDefault:"3"`
	StorageMaxTotalBytes       int64 `env:"STORAGE_MAX_TOTAL_BYTES" envDefault:"53687091200"`       // 50 GiB, all files
	DefaultWorkspaceQuotaBytes int64 `env:"DEFAULT_WORKSPACE_QUOTA_BYTES" envDefault:"10737418240"` // 10 GiB per new workspace

	// Peers allowed to set X-Forwarded-For (Caddy on loopback in prod).
	TrustedProxies []netip.Prefix `env:"TRUSTED_PROXIES" envDefault:"127.0.0.1/32,::1/128"`

	// LiveKit (rtc). All four empty = voice disabled (rtc endpoints answer 503).
	LiveKitURL             string `env:"LIVEKIT_URL"`          // for clients, e.g. wss://rtc.<domain>
	LiveKitInternalURL     string `env:"LIVEKIT_INTERNAL_URL"` // for the API, e.g. http://127.0.0.1:7880
	LiveKitAPIKey          string `env:"LIVEKIT_API_KEY"`
	LiveKitAPISecret       string `env:"LIVEKIT_API_SECRET"`
	LiveKitMaxParticipants uint32 `env:"LIVEKIT_MAX_PARTICIPANTS" envDefault:"50"`

	// Link previews: extra address ranges the unfurler may fetch from although they are not
	// public. Only for dev machines whose VPN resolves names into a fake-IP range
	// (e.g. 198.18.0.0/15). Loopback and link-local stay blocked regardless. Never set in prod.
	UnfurlAllowCIDRs []netip.Prefix `env:"UNFURL_ALLOW_CIDRS"`

	// Gateway.
	HeartbeatInterval time.Duration `env:"GATEWAY_HEARTBEAT_INTERVAL" envDefault:"41s"`
	MaxDevicesPerUser int           `env:"GATEWAY_MAX_SESSIONS_PER_USER" envDefault:"5"`

	// File bytes (ADR-0011): fs = local directory; s3 is planned.
	StorageDriver  string `env:"STORAGE_DRIVER" envDefault:"fs"`
	StoragePath    string `env:"STORAGE_PATH" envDefault:"./data/files"`
	MaxFileSizeMB  int64  `env:"MAX_FILE_SIZE_MB" envDefault:"50"`
	MigrateOnStart bool   `env:"MIGRATE_ON_START" envDefault:"true"`
}

// Load parses the environment and validates the result.
func Load() (*Config, error) {
	var c Config
	if err := env.Parse(&c); err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	return &c, c.Validate()
}

// Validate checks invariants that env tags cannot express.
func (c *Config) Validate() error {
	var errs []error
	if len(c.JWTSecret) < 32 {
		errs = append(errs, errors.New("JWT_SECRET must be at least 32 bytes"))
	}
	switch c.RegistrationMode {
	case RegistrationOpen, RegistrationInvite:
	default:
		errs = append(errs, fmt.Errorf("REGISTRATION_MODE must be open or invite, got %q", c.RegistrationMode))
	}
	if c.AccessTokenTTL < time.Minute || c.RefreshTokenTTL < c.AccessTokenTTL {
		errs = append(errs, errors.New("ACCESS_TOKEN_TTL must be >= 1m and REFRESH_TOKEN_TTL >= ACCESS_TOKEN_TTL"))
	}
	if c.AuthRateBurst < 1 || c.AuthRatePerMinute <= 0 {
		errs = append(errs, errors.New("AUTH_RATE_BURST must be >= 1 and AUTH_RATE_PER_MINUTE > 0"))
	}
	lk := []string{c.LiveKitURL, c.LiveKitInternalURL, c.LiveKitAPIKey, c.LiveKitAPISecret}
	if n := countSet(lk); n != 0 && n != len(lk) {
		errs = append(errs, errors.New("LIVEKIT_URL, LIVEKIT_INTERNAL_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set together"))
	}
	if c.HeartbeatInterval < 5*time.Second || c.MaxDevicesPerUser < 1 {
		errs = append(errs, errors.New("GATEWAY_HEARTBEAT_INTERVAL must be >= 5s and GATEWAY_MAX_SESSIONS_PER_USER >= 1"))
	}
	for name, u := range map[string]string{"PUBLIC_APP_URL": c.PublicAppURL, "PUBLIC_APP_URL_ALT": c.PublicAppURLAlt} {
		if u != "" && Origin(u) == "" {
			errs = append(errs, fmt.Errorf("%s must be an absolute http(s) URL, got %q", name, u))
		}
	}
	for _, u := range c.PublicAppURLs {
		if strings.TrimSpace(u) != "" && Origin(u) == "" {
			errs = append(errs, fmt.Errorf("PUBLIC_APP_URLS: %q is not an absolute http(s) URL", u))
		}
	}
	switch c.StorageDriver {
	case "fs":
		if c.StoragePath == "" {
			errs = append(errs, errors.New("STORAGE_PATH is required for STORAGE_DRIVER=fs"))
		}
	case "s3":
		errs = append(errs, errors.New("STORAGE_DRIVER=s3 is not implemented yet (ADR-0011)"))
	default:
		errs = append(errs, fmt.Errorf("STORAGE_DRIVER must be fs or s3, got %q", c.StorageDriver))
	}
	if c.LoginAccountBurst < 1 || c.MaxWorkspacesPerUser < 1 || c.WorkspaceCreatesPerHour < 1 ||
		c.StorageMaxTotalBytes < 1 || c.DefaultWorkspaceQuotaBytes < 0 {
		errs = append(errs, errors.New("LOGIN_ACCOUNT_ATTEMPTS, MAX_WORKSPACES_PER_USER, WORKSPACE_CREATES_PER_HOUR, STORAGE_MAX_TOTAL_BYTES must be >= 1 and DEFAULT_WORKSPACE_QUOTA_BYTES >= 0"))
	}
	if c.MaxFileSizeMB < 1 {
		errs = append(errs, errors.New("MAX_FILE_SIZE_MB must be >= 1"))
	}
	if err := errors.Join(errs...); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	return nil
}

// AllowedOrigins returns the browser origins of the web client (scheme://host[:port]),
// used for CSRF checks on cookie-authenticated requests and for gateway upgrades.
// Sources: PUBLIC_APP_URL, PUBLIC_APP_URL_ALT and PUBLIC_APP_URLS, deduplicated in order.
func (c *Config) AllowedOrigins() []string {
	var out []string
	seen := map[string]bool{}
	for _, u := range append([]string{c.PublicAppURL, c.PublicAppURLAlt}, c.PublicAppURLs...) {
		if o := Origin(u); o != "" && !seen[o] {
			seen[o] = true
			out = append(out, o)
		}
	}
	return out
}

// Origin normalizes a URL to its origin; "" if it is not an absolute http(s) URL.
func Origin(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Scheme + "://" + u.Host)
}

// LiveKitEnabled reports whether voice is configured.
func (c *Config) LiveKitEnabled() bool { return c.LiveKitAPIKey != "" }

func countSet(ss []string) int {
	n := 0
	for _, s := range ss {
		if s != "" {
			n++
		}
	}
	return n
}
