# Read-only LDAPS lifecycle

`Service` shares the SSO database/keyring/entitlements and requires a `Scanner`.
`HTTP` registers through the SSO management gate. `Run` is a supervised scheduler
with four bounded workers; configure `OnError` for redacted dependency failures.
Failed scans are throttled and cannot block healthy directories indefinitely.

`LDAP` requires an exact operator host allowlist and permitted network prefixes;
custom trust anchors come only from operator configuration. Only LDAPS port 636
with certificate/hostname verification is accepted. The bind account is read-only;
referrals, anonymous binds, request-provided filters, CA settings and host grants
are not accepted. Test loopback allowances are explicit fixture-only settings.
Paged BER responses and full scans have bounds before LDAP library allocation.

A successful full snapshot publishes eligibility atomically under a renewable
lease. Object GUID is the stable key, disabled UAC accounts lose eligibility, and
absence needs two successful reconciliations before tombstoning. Failed pages,
expired leases and outages publish no deletion or freshness. Configuration
changes clear freshness. Access fails closed after one hour without success.
Manual bans and membership roles are preserved; re-enable never clears a ban,
grants administrative roles, or changes a global account's enabled state.

TLS LDAP fixtures plus PostgreSQL race tests cover paging/outage rollback,
certificate rejection, GUID mapping, manual bans, absence snapshots, stale
access, configuration races and scheduler isolation. Real Active Directory
service accounts, server limits and operator CA deployments remain external
acceptance checks.
