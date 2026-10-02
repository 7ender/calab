# Composed identity browser acceptance

This is a narrow rerunnable acceptance harness for ADR-0054 and the 2.0 contract,
including consent continuation in specification commit `ff05248f` and the
same-session scoped reauthentication decision ADR-0055/spec `a8adc34c`. It is a
prerequisite to final QA, not release acceptance or a substitute for two independent
security reviews. Initial production source was `1b590b855051c74924dceecdf959235d3b1103c8`.
The required composed golden passed after integrating coordinator source
`479d99c8f42ffe3c5f9be47d4dbb298fcbc2707a`, on clean merge commit
`abbab7f395db3506dbe0f28b51d64ca2fd338b64`.

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

## Verified evidence

On 2026-10-01 the explicit runner succeeded on clean SHA
`abbab7f395db3506dbe0f28b51d64ca2fd338b64`, PostgreSQL 18 (57418),
Valkey (57479, DB9), real TLS Keycloak **26.4.7** (57480), Node **22.15.0**,
pnpm **10.17.0** and Go **1.26.5**. Command:

```sh
IDENTITY_TEST_HARNESS=/Users/macbook/orca/workspaces/Calaba/identity-v2-qa-env/tools/identity-test-env.sh \
IDENTITY_BROWSER_EXPECTED_SHA=abbab7f395db3506dbe0f28b51d64ca2fd338b64 \
infra/identity-test/browser-identity-e2e.sh 18
```

- Current-source web build passed; index SHA256
  `976f5ac6d101eda8ce2c090eaf0bbaf085a87341c4020ab62cc538fa77b856bc`.
- Required `-race` browser/App/Keycloak test passed, **14.403 seconds**, no SKIP.
- Local consent, local-account consent with both UI proofs, and scoped SSO consent
  each passed the same-request/S256/independent JWKS/UserInfo/revoke journey.
- Actual linking/test/activation/recovery/enforcement passed, including an
  independent local session's A denial and preserved B access.
- Actual standalone scoped UI login, secure scoped cookies/refresh, same-session
  HTTP and UI step_up, unchanged authority/local proof/absolute session deadline,
  and B/DM/global denials passed. HTTP step_up returned no new tokens.
- Owned Keycloak user/client deletion and absence checks passed. Dedicated DB
  users/workspaces/sessions and the run's Redis namespace were verified empty.
- `node --check`, `bash -n`, standalone Go compile/`go vet`, and staged diff checks
  passed. Opt-in absent SKIP was separately observed without contacting services.

Full logs, clean-checkout receipt, bundle and harness hashes:
`/var/folders/s5/vkyz575x0m57vkwlpt4mv8nr0000gn/T/calaba-browser-evidence.i8wWtR/`.
The runner's console receipt is also saved at `/tmp/identity-browser-final-run.log`.
The synthetic run id was `d5ae5458-7304-412c-abfc-dd4397b5a0bd`.

The initial real journey exposed the scoped consent dead end. The coordinator
specified ADR-0055 and integrated the scoped fix before the passing run. It also
clarified that provider `auth_time` follows authority: local accounts must perform
local reauth for `prompt=login` even when read is ALLOWED; SSO never substitutes
local proof. Both real UI actions now preserve the saved consent request.

This evidence is for the exact tested code/harness SHA above; the subsequent
commit updates only this evidence document. Final QA must rerun the explicit
runner on its own clean final SHA. PostgreSQL 17, full server integration, visual
suites, Microsoft AD/AD FS and release/deployment checks were not run here.
The broader release checks and two independent final reviews remain coordinator
work; this passing narrow golden does not claim their completion.
