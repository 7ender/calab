# Identity 2.0 isolated validation environment and evidence

## Final integrated QA ownership (2026-10-01)

The coordinator handed over this report, TESTING.md Identity2 steps 5–9 and the
browser harness's narrow CORS assertions to the final-QA worker. Preparation base
`b3b752be24f91842fe47fed758729f9560aa8b86` is **not the final release source**;
common checks and full suites await the integrated provider corrections and an
explicit final SHA. No final acceptance is claimed by the historical results below.
The required browser runner now fetches discovery/JWKS from its registered
`https://rp.identity.test` document with browser CORS, and asserts the request-uri
and authorization-response issuer metadata flags. APIRequestContext alone cannot
prove CORS. Independent Node RS256 verification and the existing golden stay intact.

Final QA uses the coordinator-assigned ORIGINAL retained harness at
`/Users/macbook/orca/workspaces/Calaba/identity-v2-qa-env/tools/identity-test-env.sh`,
QA Valkey 57479 (App DB15 / RTC14), PG18 57418 then PG17 57417 and LiveKit 57488.
Only a dedicated Garage container `calaba-identity-final-garage` on free port 57590
is created by final QA; TEST_S3_* is kept in a private temporary file. No copied
harness up/down, other-worktree changes, production changes or visual suites.

## Historical environment preparation (not final acceptance)

2026-10-01; audited/tested application baseline **`99a60fc5`**, before the identity-delivery workers'
implementation. These artifacts are Task Q only. **SSO/OAuth acceptance is planned, not executed.**
The coordinator's contract hold was lifted after ADR-0054 and `release-2.0-identity.md` were published
on identity-delivery (`149f1f64`, clarified through **`5f8b2caa`**). The enforcement proofs in
[identity-v2-route-inventory.md](identity-v2-route-inventory.md) follow that contract and remain planned.
No source/proto/SQL/production host changes, real credentials, push/deploy, full integration or visual
suite were performed. The previous design-only stop and Claude/Opus/GLM assignments were superseded
by the user's implementation/testing dispatch; this worker used Sol and ran its own targeted checks.

## Reproduce the dependencies

Requirements: local Docker Engine + Compose v2, Bash, Python 3 standard library, OpenSSL with
`req -addext`, `shasum`, Go matching the selected application revision. No API/container build or
desktop dependency installation is needed for this harness. All published services bind **127.0.0.1**.
The wrapper rejects TCP/SSH Docker engines, ignores external Compose `.env`, derives its project
from the absolute worktree path and remembers the selected port base. No `container_name`, shared
external volume/network, privileged mode, host network or global Docker prune is used.

```sh
tools/identity-test-env.sh ports
tools/identity-test-env.sh config
tools/identity-test-env.sh up core          # PG18 + QA Valkey only
tools/identity-test-env.sh up pg17          # optional compatibility database
tools/identity-test-env.sh create-db 18 qa
tools/identity-test-env.sh create-db 17 qa
eval "$(tools/identity-test-env.sh env 18 qa)"
tools/identity-test-env.sh smoke 18 qa
tools/identity-test-env.sh up oidc          # optional HTTPS Keycloak, waits for discovery
tools/identity-test-env.sh oidc-smoke       # actual authorization-code fixture checks
tools/identity-test-env.sh up rtc           # optional isolated LiveKit for targeted later tests
tools/identity-test-env.sh status
# ONLY after coordinator/users of this harness release it:
tools/identity-test-env.sh down             # only this project, including its own volumes/TLS
```

For a conflicting local port range use `IDENTITY_TEST_PORT_BASE=58400` on first startup. The wrapper
persists it in the ignored `.runtime/<path-hash>/port-base`; later commands use the saved value.
Attempting to change it before teardown fails. Different worktrees have different projects but
must select different port bases if run on the same machine. `down` does not remove shared pulled
images or build cache, other Compose projects, other worktrees, desktop artifacts or GPU workloads.

Default reservation for this worktree: project **`calaba-identity-test-592e1b88c8`**.

| Dependency | Host port(s) | Capability and isolation |
|---|---|---|
| PG18 | 57418 | PG18.6, pinned CI image digest; project-only volume `/var/lib/postgresql`; named per-worker DB, test-only admin. |
| PG17 | 57417 | PG17.11, pinned CI digest; separate volume `/var/lib/postgresql/data`; application migrations provide uuidv7 compatibility (ADR-0037). |
| QA Valkey | 57479 | Valkey9 pinned CI digest; DB15 app lease, DB14 RTC, no persistence; separate container. |
| Foundation / RP / provider / enforcement Valkey | 57481 / 57482 / 57483 / 57484 | Independent containers, started on demand via corresponding profile, each DB15 + DB14. Pubsub isolation comes from container plus prefix, not Redis DB alone. |
| Keycloak | 57480 HTTPS | 26.4.7 pinned pulled digest, disposable dev-file database inside container; realm `identity.test`; untrusted locally generated 30-day localhost/identity.test/127.0.0.1 certificate. No Caddy, public DNS, ACME or production CA. |
| LiveKit | 57488 signal, 57489 TCP, 57490 UDP | Pinned CI v1.13, development credentials `devkey`/`secret`, independent instance. Signaling is reachable; browser media/NAT routing and webhook delivery are not accepted by this setup check. |

PG/Valkey health checks prove readiness; OIDC additionally fetches HTTPS discovery/JWKS with the
local CA. Keycloak's container health probe only checks its TLS listener, so **`up oidc` also waits
for discovery**. LiveKit has no Compose healthcheck; its running state is not an RTC acceptance test.
CPU/memory limits keep idle fixtures bounded; core omits Java/SFU and all auxiliary worker stores.
No LDAP/AD-compatible container is included: the frozen contract includes direct LDAPS sync,
but its fixture/implementation is owned by the Directory worker. This harness does not provide
LDAP transport, objectGUID or directory lifecycle evidence. Keycloak is an OIDC IdP, **not Microsoft AD**.

## Parallel worker namespaces

All five databases (`identity_qa`, `identity_foundation`, `identity_rp`, `identity_provider`,
`identity_enforcement`) were created and verified on both PG versions. Initial passwords are
disposable public fixture constants, never production credentials. For an integration worker:

```sh
# Run from the harness-owning worktree. These commands affect only its project.
tools/identity-test-env.sh up foundation pg17
tools/identity-test-env.sh create-db 18 foundation   # idempotent
tools/identity-test-env.sh create-db 17 foundation
eval "$(tools/identity-test-env.sh env 18 foundation)"
# Other roles: rp, provider, enforcement, qa. PG17: env 17 <role>.
```

Example emitted environment (foundation, PG18):

```sh
export TEST_PG_URL=postgres://identity_test:fixture-only-password@127.0.0.1:57418/identity_foundation
export TEST_DATABASE_URL=$TEST_PG_URL
export TEST_REDIS_URL=redis://127.0.0.1:57481/15
export TEST_RTC_REDIS_DB=14
export TEST_REDIS_KEY_PREFIX=identity-test:592e1b88c8:foundation:pg18:
export TEST_LIVEKIT_URL=ws://127.0.0.1:57488
export TEST_LIVEKIT_INTERNAL_URL=http://127.0.0.1:57488
```

Root `Makefile` uses `TEST_DATABASE_URL`; `internal/app`'s fixture prefers `TEST_PG_URL` then
`TEST_DATABASE_URL`, creates/migrates/drops `calaba_it_<random>`, and leases a logical Valkey DB.
The helper emits **both** PG variables. Other package fixtures often read only `TEST_DATABASE_URL`
and may create schemas or flush DBs directly. Run one process/version per worker role at a time;
separate roles may run concurrently. Switching 18 -> 17 does not create a second Valkey server for
that same role. App leasing is not permission for arbitrary non-leasing tests to share a role.
PostgreSQL roles are not tenant-security boundaries here: the test admin can create DBs, and each
worker must still target its assigned database. Setup SQL creates databases only; production SQL
and application migrations were not edited.

## OIDC fixture capability

The realm fixture imports the confidential `calaba-identity-test` client, mandatory S256 PKCE,
authorization-code flow only, and exact redirect `http://127.0.0.1:57500/identity-test/callback`.
Issuer is **`https://127.0.0.1:57480/realms/identity.test`**, with the existing IP SAN; `localhost`
is not the approved identitynet loopback exception. There are enabled `alice@identity.test` and disabled `disabled@identity.test` subjects. Fixture
passwords/client secret are plainly labeled synthetic in `realm.json`; no real credential is
requested or stored. A real RP integration needs an explicitly configured local CA and loopback
test network allowlist through its supported test hooks; **never disable production TLS/SSRF
validation to make this fixture pass**. TEST_OIDC_* are harness conventions, not claimed supported
Calaba configuration variables. The fixed callback is part of the fixture, independent of port base;
adapt a fixture client explicitly if the frozen RP endpoint differs.

`oidc-smoke.py` fetches issuer/JWKS with local CA trust, follows the login form with a cookie jar,
captures the callback without opening a listener, exchanges a code with client secret/verifier,
checks fixture claim issuer/audience/nonce/email, then tries code reuse, a wrong verifier and the
disabled subject. It prints no codes, passwords or tokens. JWT payload checks **do not** independently
verify the signature and are **not** RP token-validation coverage. Client/API tokens are not persisted.
Realm changes require recreating the fixture container, since startup import skips an existing realm.

Container/import/TLS configuration was checked against Keycloak's official
[container guide](https://www.keycloak.org/server/containers),
[realm import rules](https://www.keycloak.org/server/importExport) and
[hostname guide](https://www.keycloak.org/server/hostname). PG volumes follow the official
[Postgres image guidance](https://hub.docker.com/_/postgres).

## Executed checks (baseline only)

Host: Docker Desktop4.37.2/Engine27.4.0, Compose2.31.0, macOS arm64, Go1.27.1 (CI uses1.26.x),
Python3.14.6. Free host disk before setup: 33GiB. Existing dev DB/Valkey/LiveKit, unrelated DB and
buildkit containers were observed and left untouched. No Go dependency/generated source change.

| Executed command / assertion | Result |
|---|---|
| `bash -n tools/identity-test-env.sh`; `shellcheck tools/identity-test-env.sh`; `tools/identity-test-env.sh config` | Passed after fixes; all optional profiles validate. |
| `python3 infra/identity-test/test-env.py` (fake engine in throwaway directory) | Five safety tests: core-only selection/stable ports, remote-engine rejection, invalid role/version/base rejection, scoped DB command, scoped teardown preserving unowned files. Does not stop the retained live services. |
| `up core pg17 foundation rp provider enforcement`; `create-db` and `smoke` for five roles × two PG versions | All 10 database version SELECTs and all role Valkey PONG checks passed; 10 named databases created; owned PG/Valkey containers healthy. |
| `up oidc`; `oidc-smoke` | Passed 5 printed assertions: local TLS/discovery/RSA JWKS, code+PKCE exchange/claims, code reuse rejected, wrong verifier rejected, disabled user no code. |
| `up rtc`; `curl -fsS http://127.0.0.1:57488` | Running and HTTP response `OK` verified; no media session/eviction timing claim. |
| `cd apps/server && go test -race -count=1 ./internal/auth ./internal/perm ./internal/gateway ./internal/rtc` | Four packages passed: 2.690s / 1.025s / 1.224s / 1.221s. |
| Targeted auth integration command below, QA namespace PG18 and PG17 sequentially | 11 top-level tests passed on each version, 19.631s / 18.999s; no selected test skipped. Fixture migrations/cleanup also completed. |
| `python3 infra/identity-test/route-inventory.py` | 266 unique patterns: baseline literal census = bot table = documented classes. |

Reproducible targeted filter (no full suite):

```sh
eval "$(tools/identity-test-env.sh env 18 qa)" # repeat with 17, sequentially
cd apps/server
go test -race -tags integration -count=1 -run '^(TestBootstrapAndInviteOnlyRegistration|TestRefreshRotationAndReuseDetection|TestRefreshLostAnswerReplay|TestLogoutAndSessions|TestLoginRateLimitAndBadCredentials|TestWebCookieAuth|TestRevocationIsInstantWithLongAccessTTL|TestRevocationWithoutMarkerFallsBackToDB|TestRevocationCheckWithPostgresDown|TestRevocationCheckWithValkeyDown|TestBotRouteTable)$' ./internal/app
```

Observed/fixed harness errors before the passing run: Keycloak import filename must match
`identity.test-realm.json`; its first failed startup did not count as healthy. Python opener variable
initially shadowed `http.cookiejar`, and `up oidc` initially passed its profile to PG env validation;
both corrected and rerun successfully. The Go/CI version difference remains a reproducibility caveat;
the final OIDC smoke was rerun successfully after replacing the advertised localhost issuer with
the contract's literal 127.0.0.1 issuer. A fake-Docker test shim initially consumed SQL stdin during
context lookup; the shim was corrected, and all five safety assertions then passed.
Generation drift, root lint and TS checks were not run for these shell/Compose/fixture/docs changes;
application/proto/SQL were untouched, and targeted artifact checks are recorded above.
`apps/server/Makefile` does not exist; server production workers must use the actual root `make lint`
target (which includes integration-tag Go lint and TS lint), not a guessed per-server target.

## Audited existing coverage and planned acceptance

Existing tests cover local register/login/refresh, session revoke and dependency failure, cookies,
bot route census, guest admission, permission matrices/closed rooms/boards, READY/RESUME, files and
RTC membership synchronization. Only the auth filter and four unit packages above were executed here.
Audit references in the route document are **not** claims that their full packages were run. There
are no identity assurance/scope tests at this baseline; do not rename existing auth tests as 2.0 proof.

Planned integration matrix: two workspaces A(enforced)/B(optional), same local user with memberships
and separate local/scoped sessions, owner/admin/superadmin/guest/bot identities, room/board/task/file
resources, active gateway instances/buffered events and RTC participants. Extend existing fixtures;
add behavior proofs at the integration worker's actual implementation commit. Required negative
evidence is summarized by G0/G1/W0/R0/F0/A0/C0/M0/GW/RTC in the route inventory; each applicable
route/channel needs a passing case, a denial and no side effects. Provider token-isolation, consent,
refresh family/races, key lifecycle and RP attack tests belong to their package owners.

Still planned: final generated drift and root CI lint on implementation; PG18/17 migration/backward
compatibility and scoped/global authority tests; OIDC SSRF/issuer/audience/nonce/key confusion and
native handoff; provider client/redirect/consent/replay/refresh-race isolation; all route/channel
enforcement proofs, measured stale-delivery/eviction deadlines and dependency failure; one coordinated
full integration run; manual UI screenshots (visual suite remains prohibited); two independent
security/protocol reviews of the final integration commit. No release signoff is claimed here.

Real **Entra/AD FS** acceptance remains unexecuted: organization registration and exact issuer/tenant
claims, public versus private discovery/JWKS reachability, certificate/CA chains, account linking,
MFA/conditional-access/auth-time behavior, disabled/deleted-user behavior across existing sessions,
refresh and revocation signals, recovery/downgrade and on-prem firewall behavior require a disposable
Microsoft tenant/federation environment and approved test identities. LDAP bind/TLS/objectGUID,
paging/referral handling and sync/deprovision are unavailable, not simulated by this OIDC fixture.
Disabling the fixture subject proves denial of **new fixture login**, not immediate deprovision or
revocation of an already issued Calaba/RP/SFU session. Real AD claims require measured evidence.

## Resource lifecycle

The coordinator explicitly requested retention while implementation workers use these dependencies;
all owned services remain running at handoff. Teardown command/scoping is documented and reviewed,
but **final live teardown was not executed** because it would destroy their published databases.
Only the harness project's Keycloak container was recreated while fixing startup; no other project
was stopped/restarted. Coordinator can run this worktree's `tools/identity-test-env.sh down` after
all consumers finish. The wrapper owns only project containers/network/volumes and its ignored TLS
runtime directory. Keeping pulled images is intentional; no global prune.
