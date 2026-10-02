// Package signing implements RS256 provider JWTs with operator-configured RSA
// keys, independently of first-party JWT_SECRET. New parses PEM into an immutable
// keyring; only the explicitly active kid can sign. Other keys publish and verify
// only, even when configured with private PEM. JWKS exports public n/e fields.
//
// Rotation uses configuration replacement: publish a staged public key alongside
// the active key, wait the relying parties' maximum JWKS cache lifetime, restart
// with that key's private PEM and ActiveKID, then retain the old public key for
// maximum issued token lifetime + skew + cache propagation before removing it.
// Retirement is omission from the new config. Scheduling these deadlines and
// emergency grant revocation belong to the application, not this crypto package.
//
// Claims are typed; profile/email disclosure and consent remain caller policy.
// Sign and Verify require the exact expected audience as a separate argument,
// selected from trusted client configuration, not copied from an untrusted JWT.
// Algorithm and key encoding follow RFC 7518 sections 3.3 and 6.3.1; validation
// follows RFC 7519 section 4.1 and RFC 8725 sections 3.1, 3.8, and 3.9.
package signing
