# Composed identity browser acceptance

This is a narrow rerunnable acceptance harness for ADR-0054 and the 2.0 contract,
including consent continuation in specification commit `ff05248f` and the
same-session scoped reauthentication decision ADR-0055/spec `a8adc34c`. It is a
prerequisite to final QA, not release acceptance or a substitute for two independent
security reviews. Production source used during development:
`1b590b855051c74924dceecdf959235d3b1103c8`.

Run from a clean checkout of the exact commit under review, after installing the
locked dependencies (`pnpm install --frozen-lockfile --ignore-scripts`) and Chromium
(`pnpm -F @calaba/desktop exec playwright install chromium` if absent):

```sh
IDENTITY_TEST_HARNESS=/Users/macbook/orca/workspaces/Calaba/identity-v2-qa-env/tools/identity-test-env.sh \
IDENTITY_BROWSER_EXPECTED_SHA=$(git rev-parse HEAD) \
infra/identity-test/browser-identity-e2e.sh 18
```

The original retained fixture must already be running. The runner never starts,
replaces or stops it. Node 22, pnpm 10 and Go 1.26.5 are required. PostgreSQL 17
can be selected with `17` when that retained service is available. No external
credentials are needed: only the fixture's synthetic Keycloak admin is used.
The runner builds this checkout's web client once, then runs exactly:

```sh
cd apps/server
GOTOOLCHAIN=go1.26.5 go test -race -tags integration -count=1 -timeout 5m -v \
  ./internal/app/identity_browser_e2e_integration_test.go
```

Running the new file directly avoids the existing App package's TestMain, which
creates/drops a separate database and flushes a leased Redis DB. This harness
instead migrates the dedicated local `identity_browser` database, seeds only its
synthetic user/workspaces/members/plan grants, and removes only its owned rows.
Valkey DB9 uses a random per-run namespace and exact-prefix SCAN/DEL cleanup,
never FLUSHDB. The temporary Keycloak client has exact App callback and
basic/profile/email scopes. Its separately named synthetic user and client are
deleted and absence is verified. Nothing resets the realm or other workers' data.

An ephemeral local HTTPS server serves the final web bundle and production App
routes. App uses actual auth/token issuance, local/scoped cookies, SSO quotas,
provider and gateway. The sole trusted Go override pins the real fixture's TLS CA
and exact loopback IdP endpoints. Chromium ignores synthetic certificate errors,
has no media permissions and is muted. The only intercepted request is this
run's synthetic downstream RP callback; Calab and IdP APIs are never mocked.

The journey covers local UI login; consent needing fresh local proof while the
read summary is ALLOWED; actual HTTP linking/test/activation/recovery/enforcement
through real browser Keycloak login; independent local-session A denial and B
access; production scoped SSO issuance, scoped cookie refresh and B/DM/global
scope denials; consent SSO navigation returning to the original request; consent
code + S256 exchange; independent Node crypto RS256 verification from public JWKS
with issuer/audience/opaque subject/nonce/auth_time/expiry checks; UserInfo, code
replay rejection, first-party rejection of provider tokens and revocation.

The explicit runner sets `CALABA_IDENTITY_BROWSER_REQUIRED=1` and fails on SKIP,
missing golden marker, Node/assertion failure or cleanup failure. Without that
flag the test skips in ordinary integration CI. Optional
`IDENTITY_BROWSER_EXPECTED_SHA` requires an exact SHA and clean working tree.
Evidence logs contain source SHA, environment versions, working-tree status,
harness hashes, bundle hash, build output and browser/test output in a printed
per-run temporary directory. They contain no upstream codes or credentials.

## Development evidence and current limitation

- Web build succeeded on production source `1b590b85`; bundle index SHA256
  `976f5ac6d101eda8ce2c090eaf0bbaf085a87341c4020ab62cc538fa77b856bc`.
- `node --check`, `bash -n`, standalone Go compile and `go vet` succeeded.
- Opt-in absent: standalone test SKIP observed, without contacting services.
- Targeted `-race` run on PostgreSQL 18, Valkey DB9 and real TLS Keycloak 26.4.7
  passes local consent + S256/JWKS/UserInfo/revoke, real control-plane/enforcement,
  independent B, actual standalone scoped UI login/cookie/refresh/denial cases,
  and local-account consent after explicit local reauth plus actual SSO return.
- The required golden is pending the scoped same-session reauthentication fix;
  `/tmp/identity-browser-target.log` reproduces STEP_UP begin HTTP 403 for the
  live scoped session on `1b590b85`. This run must not be reported as passed.

The coordinator clarified that provider `auth_time` follows authority: local
accounts must complete local reauth for `prompt=login` even when read is ALLOWED.
SSO never substitutes that local proof. The local golden now uses both actual UI
actions and returns to the same saved consent request successfully. This is
contract clarification, not a production bug or a weakened freshness check.

ADR-0055 permits live scoped same-session step_up; implementation is assigned to
another worker. The new golden additionally asserts no tokens from HTTP step_up,
actual scoped consent navigation, unchanged session id/authority/local proof and
absolute refresh deadline, followed by B/DM/global denials and scoped logout.
These dependent assertions remain required and failing until that fix is merged.
No production edits, auth injection, proof timestamp mutation or mocked API
response is hidden in the harness. Full server integration, visuals, Microsoft
AD/AD FS and release/deployment checks are outside this artifact's evidence.
