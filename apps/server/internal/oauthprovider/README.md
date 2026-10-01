# Workspace OAuth/OIDC provider

This package implements ADR-0054 and the frozen Identity v1 release contract.
It has no first-party auth, app, UI, SQL, migration, dependency, or signing-key
ownership. Existing shared queries and `oauthprovider/signing` are dependencies.

Integration uses `New(Config) (*Service, error)` followed by
`RegisterRoutes(httpx.Router)`. The router interface preserves the application's
route recorder and middleware. Config requires a database, trusted HTTPS
`PublicOrigin`, positive entitlement config, `SessionResolver`, and
`SignerForWorkspace func(uuid.UUID) (*signing.Keyring, error)`. `Now` is an optional
trusted clock. A signer must pin the exact workspace issuer, use independently
configured RSA keys, and retain verification keys through the rotation overlap.
The application validates the operator key configuration at startup.

`SessionResolver` has signature
`func(context.Context, *http.Request) (identitypolicy.Principal, error)`.
Consent, client administration, and grant routes require a first-party bearer;
the provider rejects known provider and bot prefixes before calling the resolver.
Only authorize may resolve an ordinary browser session for `prompt=none`.
Every issuance/profile boundary reloads database authority, membership, positive
entitlements, policy, directory state, assurance, and durable versions.

The consent page is `/oauth/consent?request=<opaque handle>`. It sends generated
`BindOAuthRequest` with `csrf_token = handle` to `/api/oauth/requests/{handle}/bind`,
including its bearer, exact configured Origin, and the per-request browser cookie.
The generated snapshot returns a new CSRF token. Decision sends generated
`DecideOAuthRequest` with that token, `allow`, and `allow_refresh` and receives
`OAuthDecisionResponse.redirect_url`. Proto JSON uses its usual lowerCamelCase
field names. Client, user, session, scopes, redirect, nonce, and versions come from
the saved server snapshot; rebinding or account substitution is rejected.

The integrator must serve that page with `frame-ancestors 'none'`, retain the
provider's no-referrer/no-store headers, redact protocol query strings and secrets
from access logs, add the application's endpoint rate limits, proxy both metadata
paths before SPA fallback, and consume the identity invalidation outbox. No
handler uses cookie credentials at token/revoke/UserInfo or interprets a provider
token as a Calaba API token. End-to-end Calaba API/WS/RTC rejection is integrator
acceptance work, not proven by the isolated provider tests.

Client mutation routes accept generated management DTOs; the path identifies the
public client ID or returned record ID. PATCH takes the complete editable snapshot
and expected security version. Name-only updates preserve that version. Security
updates and secret rotation revoke families and invalidate pending requests/codes.
Only two unexpired secrets are accepted during the bounded ten-minute overlap;
`revoke_old` closes it immediately. Secret responses and all protocol credentials
are no-store and secrets are shown once.

Transactions lock workspace/policy before client/grant and the matching identity
boundary, then load policy state. Post-lock checks use fresh application and DB
clocks; issued lifetimes satisfy both clocks and stored source-session/proof/grant
deadlines. Refresh reuse and access loss commit durable revocation even when the
HTTP response is an error. Refresh scope narrowing persists on the entire family.

Run from `apps/server`, using the existing isolated provider-role fixture:

```sh
go test -race -tags integration -count=1 ./internal/oauthprovider/...
```

Set `TEST_PG_URL` to the provider role on PostgreSQL 17 or 18. Each test creates and
drops its own random database and runs the actual migrations. The independent RP
uses HTTPS, wire discovery/JWKS, and direct RSA/JWT verification, not signer Verify.
The suite covers replay/races, CSRF/account binding, exact redirects, scopes, secret
rotation, grant revocation, original-proof deadlines, lock waits, clock skew,
cross-issuer subjects, token confusion, downgrade, and key rotation. Run `make lint`
from the repository root. Full server integration and two final independent
security/protocol reviews remain coordinator-owned acceptance gates.
