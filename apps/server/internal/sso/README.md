# Corporate SSO service integration

`Service` requires the database, identity keyring, operator entitlement edition,
`OIDC` with a trusted HTTPS origin and endpoint policy, and an injected
`SessionIssuer`. The issuer signs tokens for the transaction's already inserted
session without committing; it must preserve its workspace authority. Local
step-up adds assurance to the initiating session. Corporate login creates only a
workspace-scoped session for an explicitly linked, existing account and member.

`HTTP.Routes` accepts the root router through `Registrar`. `HTTPDeps` supplies
principal resolution, atomic shared rate limiting, trusted peer IP, result/cookie
delivery, and wire-error mapping. Missing rate limiting fails closed. Map
`*AccessError.Decision` before the compatible `ErrDenied` fallback; real database
errors remain unwrapped, and provider validation returns opaque `ErrInvalidProof`.
`CheckDecision` uses the maximum application/database clock; sensitive callers use
transaction-bound queries after taking their boundary locks.

Management is owner-only with independent recent local proof and, when enforced,
fresh corporate proof. Link an owner first, finish a provider test, then explicitly
activate that exact revision. Test does not issue tokens or assurance. Enforcing
requires a live recovery kit and both proofs. Kits contain ten one-use codes and
expire after 365 days. Recovery authority can only relax policy through its
restricted repair operation. Credential rotation invalidates flows, proofs,
scoped sessions and OAuth grants; new issuer/client credentials cannot silently
reuse the old secret.

`OIDC` uses a single discovery snapshot and guarded transports for discovery,
JWKS and token exchange. Generic OIDC, fixed-tenant Entra, and ADFS configuration
all require code/S256, state/nonce and issuer/audience/authorized-party/time claim
validation. auth_time is required from every provider (Entra: optional ID token claim);
its absence fails with ErrAuthTimeMissing and an auth_time_missing audit record. ADFS discovery must list S256; a
generic provider omitting the list is audited at test. There is no email-based
linking, account creation, or global email verification. ADFS operators must use
2019 or newer with S256 support. Pending browser flows share one bounded binding
cookie.

The integration suite exercises actual PostgreSQL transactions with a TLS fake
IdP, native/web one-use races, policy revisions, recovery restrictions, clock
skew and HTTP origin/cookie gates. Real Entra, ADFS and operator deployment
interoperability remain external acceptance checks; the fixture is not evidence
that those providers were tested.
