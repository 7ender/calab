# Calaba SSO RP: live Keycloak acceptance

Executed 2026-10-01 against normative ADR-0054 / release-2.0-identity.md at
`37ad541d5083d7d853849020d8749e4f90c98982`. Tested implementation/test commit:
`4a855ff2ef86e810c02e9680f875fb92fd69d262` (this evidence is a subsequent docs-only commit).

Environment: Go 1.26.5 darwin/arm64; golangci-lint 2.14.0; PostgreSQL 18.6 on
127.0.0.1:57418, private database `identity_keycloak`; retained Docker project
`calaba-identity-test-592e1b88c8`; Keycloak 26.4.7 (asserted via admin serverinfo),
TLS issuer `https://127.0.0.1:57480/realms/identity.test`, original fixture CA at
`/Users/macbook/orca/workspaces/Calaba/identity-v2-qa-env/infra/identity-test/.runtime/592e1b88c8/tls/localhost.crt`.

Reproduce from repository root, with the ORIGINAL retained harness; do not invoke
`up`/`down` or reset another worker's database:

```sh
GOTOOLCHAIN=go1.26.5 \
IDENTITY_TEST_HARNESS=/Users/macbook/orca/workspaces/Calaba/identity-v2-qa-env/tools/identity-test-env.sh \
infra/identity-test/calaba-keycloak-test.sh 18
```

The runner creates only `identity_keycloak` if absent, exports the fixture TLS/admin
environment, and runs `go test -race -tags integration -count=1 -timeout 3m -v
-run '^TestKeycloakLiveRP$' ./internal/sso`. PASS: 1 test / 8 subtests, no skips;
Keycloak flow 1.90 s, package 3.714 s at the tested commit.

| Live scenario | Observed result |
|---|---|
| Missing auth_time | Remove built-in basic scope from only the temporary client; real code callback rejects upstream proof, finish fails, no identity created; restore scope |
| Explicit link / test / activate | Fresh independently local session links real Keycloak subject; draft link and test issue no tokens; tested connection activates |
| Standalone web login | No local bearer; actual authorize form → server code exchange/JWKS verification → callback → finish creates workspace A session/assurance |
| Browser/state/replay | Wrong/missing cookie, wrong state, callback replay, wrong finish cookie and finish replay all rejected |
| Native login | Real browser-start/form/callback; bootstrap replay, intercepted ticket with wrong initiating verifier and exchange replay rejected; correct exchange scoped to A |
| Equal email | Local verified email equals Alice's fixture email; temporarily unmatched subject reaches exact identity-not-linked denial, with no new identity or finish result; tuple restored |
| Disabled upstream user | Keycloak login form gives no code for disabled fixture user; pending RP finish denied |
| Normal local step-up | Adds A assurance without issuing tokens or changing local authority, local auth timestamp, expiry, or independent B/global access |
| Upstream protocol negatives | Production OIDC.Exchange rejects real code replay, wrong upstream S256 verifier and nonce mismatch; unapproved JWKS endpoint denied |

Both web and native session rows assert `workspace_sso`, exact A/connection/user,
no local authentication timestamp; production SQL loader/policy allows A and denies
B despite membership and denies global read. Upstream ID tokens are never fabricated;
production go-oidc RemoteKeySet performs verification against Keycloak's real RSA JWKS.

Temporary client `calaba-rp-<uuid>` uses one exact synthetic callback
`https://calaba.test/api/auth/sso/callback/<connection_uuid>`; no callback socket is
needed because the form driver captures the redirect and dispatches it to the real
RP HTTP handlers. Only the temporary client is deleted, followed by an absence check.
Fixture DB cleanup left users/workspaces/sessions at zero. Existing realm, Alice,
original client, other databases and Valkey instances were not changed/reset.

Operator requirement: retain Keycloak's built-in `basic` default scope, alongside
`profile`/`email` here. It supplies the auth_time mapper; omitting it gave a genuine
HTTP 200 token response without auth_time even with max_age=3600/prompt=login, which
Calaba correctly rejected. No iat fallback/static mapper was added. Primary source:
[Keycloak upgrade instructions at 26.4.7](https://github.com/keycloak/keycloak/blob/26.4.7/docs/documentation/upgrading/topics/changes/changes-25_0_0.adoc).

Other checks passed: `GOTOOLCHAIN=go1.26.5 make lint` from root (Go vet with/without
integration tags, golangci-lint zero issues, all pnpm lint); SSO unit `go test -race -count=1`;
`bash -n infra/identity-test/calaba-keycloak-test.sh`; gofmt and git diff whitespace.
Without `CALABA_KEYCLOAK_LIVE=1`, the live test explicitly SKIPs: verified with the
same integration filter, and that result is NOT live acceptance.

Scope limits: HTTP Principal/quota/token delivery are injected root seams; the reused
fixtureIssuer returns session metadata, not production first-party JWT/cookie delivery.
This is real upstream RP/service interoperability, distinct from Python oidc-smoke.py
(which proves only Keycloak) and fake TLS claim tests. Full app routes, refresh/WS/RTC,
physical browser UI, full server integration, independent reviews and release/CI were
not run in this task. Entra ID, AD FS and Microsoft AD remain UNVERIFIED without their
real credentials/fixtures. Coordinator final QA must rerun the command on final integrated SHA.
