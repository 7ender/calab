# Identity 2.0 delivery handoff — 2026-10-01

Integrated implementation SHA: `074337e0` (parent `229a904f` changes delegation to built-in Codex agents). No push, PR, tag or deployment. Main remains `99a60fc5`. This is **not release acceptance**.

## Ownership and preservation

The architecture/main lead requested this handoff in `msg_abc46f2176a8`; new tasks use built-in Codex agents, SOL, isolated worktrees, max four including lead. Do not start another Orca coordinator or new Orca workers. Existing run: `run_d5d0de9918d4`.

At handoff, runtime reports Compat `ctx_1117b66a53e6` failed/process_exited, retained user_takeover; QA `ctx_4198b07e6550` stopped/failed and released; Files `ctx_e3d47106d689` completed, retained user_takeover (release returned no process action). All three old worktree directories are now absent; Compat and QA branch names also no longer resolve. Their uncommitted work must be recovered from the cleanup owner's preservation artifacts, **not assumed merged or passed**. Do not force-close user-owned resources. No old worker is still an authorized implementation writer.

## Accepted latest changes

- Files `9f3d90e3` integrated as `074337e0`: candidate-specific current identity plus permissions for source uploader/icons, live attachment/sticker rooms, exact scoped profile image; expected denials continue, dependency errors stop. Only `internal/files/files.go` and new App integration test. Evidence `/tmp/identity-file-refs-evidence/report.md`: Go 1.26.8, PG18, Redis DB4, five direct CanRead integration/race tests, files race units and focused vet passed. Actual App route test intentionally fails before missing route glue. Review still required on final assembled delta.
- QA fixture correction `534009d5`: restore camera CLI `--url` to assigned LiveKit; cached owner/admin fixtures obtain real fresh local password proof. Five camera/provider top-level tests + 19 subtests passed; two admin tests still fail 503 because operator-off local reauth is currently disabled. Do not hide this by using a separately configured App.
- Toolchain `83bb2143`: Go 1.26.8 minimum/browser harness and explicit Docker tag; Docker digest already contained 1.26.8. `/tmp/identity-toolchain-taskba4/report.txt`, `govulncheck-go1.26.8.log`: zero called vulnerabilities. No dependency upgrade.

## Next implementation task: finish compatibility bundle

Contract is `docs/plans/release-2.0-identity.md` section 13 (through `ca20fdc8`), ADRs 0033/0040/0044/0054/0055. Previous partial edits were in gateway/**, App identityroutes/app/identitywiring, a new identity_compatibility_integration_test, typed SQL parent lookup + generated SQL. Recover before assigning a single new owner. No frontend/proto/RTC redesign.

1. Human local account may GET bot card; existing bot deny and scoped/recovery deny remain.
2. Local own pending/declined guest admission receipt survives lost membership only for current off/optional workspace policy. No protected workspace lease. Explicit typed event proof bound to user/session and rechecked at final socket write/replay, <=30 seconds, DB failure/enforced denied.
3. Cold/invalidated event leases prepare outside websocket locks with bounded queues; preserve ordering; overload requires explicit resync rather than silent drop.
4. Explicit typed local empty-room DM voice departure and local NOTES_DELETE delivery; never general fallback for unknown events.
5. Remove accidental 256-membership READY ceiling. Cache bounded by real durable memberships/subscriptions with pruning, no positive entry allocation from unknown notice IDs. Test 257 memberships and deletion/pruning.
6. Unknown invite preview must consume existing per-IP limiter before early 404; no double charge or enforced metadata leak.
7. Identity room/message parent attribution must include archived temporary rooms; original handler controls readable history versus 410 writes/voice. Typed SQL only.
8. `POST /api/auth/local/reauth` must work without SSO keyrings, local bearer/password only, existing limiter, nonempty exact trusted operator AllowedOrigins or configured identity origin. Wrong/empty/null/Host-derived origins, bot/scoped/recovery denied. Corporate endpoints remain 503 when disabled; partial config still fails startup.
9. File GET/HEAD/thumbnail identity wrapper delegates to integrated CanRead with existing WithPolicy; remove premature source-workspace gate. Run TestIdentityFileReferencesAppRoutes, TestForwardMessages and scoped profile-image regression.

Lead identified a major in the unfinished receipt implementation: a global receipt epoch invalidated workspace B receipt/READY on any A notification, including stale/duplicate notices. Use workspace-scoped monotonic policy/access version, bounded to actual prepared own receipts with expiry pruning; test A/B isolation, duplicate/stale notifications and final socket/replay checks. Do not accept the previous global atomic epoch.

Historical partial evidence `/tmp/identity-compat-task45/first-fix.log`: seven legacy tests passed (GuestAdmissionAdmit/Decline, BotLifecycle, CallFullCycle, NotesShelves, PublicInvitePreview, TempRooms). `unit-race.log` gateway passed. `new-tests.log` ended in compile failures (bot versus user type, nonexistent BeginSSORequest, name pointer); no final compatibility commit/acceptance exists.

## Final validation task, after implementation and review

QA artifacts `/tmp/identity-final-qa-task929/`. Full PG18 on `415e1a30`, Go1.26.5, took 896s: 590 top-level +614 subtests passed; 39 top-level failures; 3 optional B/K/SIP skips; 44 packages passed, App failed. `integration-pg18-failures.md`, `.failures.json`, `.summary.json`, `.receipt.json` contain exact failures. These are not final green results.

Failure groups: five camera fixture URL; four stale provider-owner proof; thirteen stale global-admin proof/operator-off reauth; seven compatibility cases above; nine READY/no-frame cases (GatewayFlow, ProfileBroadcast, ProfileTimezone, RTC, ReadReceiptsRoom, RecordingFlow, SIP, ServerMute, SoundPlay); ForwardMessages. All must close on assembled source, not waived as unrelated.

On final accepted SHA run generation/drift, root `make lint`, Go unit race, complete server integration/race on PG18 then PG17 (30-minute timeout justified), required real TLS Keycloak and actual browser/App journeys, proxy/config checks. One QA owner; no repeated full suites on unchanged inputs. Prior TS unit/typecheck: 2594 tests passed, 990-file input hashes can justify reuse if unchanged. No visual suites/full UI regression; 24 new-screen desktop/mobile screenshots already reviewed.

Required browser CORS checks were added in `e9e5c0eb`: actual page fetch of discovery/JWKS with CORS response, not APIRequestContext. Latest browser attempt stopped on missing headless shell; installation succeeded but journey rerun remained held. Required Keycloak older SHA passed; rerun after relevant Go changes. T12 actual issued access/refresh/ID token cross-protocol isolation and UserInfo bot semantics passed at `e0ff654c` (receipt `token-isolation-bot-fix-passing.receipt.json`, not older failing `...final.receipt.json`).

Environment formerly sourced original `/Users/macbook/orca/workspaces/Calaba/identity-v2-qa-env/tools/identity-test-env.sh env 18 qa`; directory may now be removed, restore harness from preserved source. PG18 57418, PG17 57417, QA Valkey 57479 (QA App15/RTC14, explicit TEST_RTC_REDIS_DB); LiveKit57488. Required S3 Garage57590 (`calaba-identity-final-garage`); missing S3 is not a passing skip. Go1.26.8, Node22, pnpm10, golangci2.14, sqlc1.31.1. Never expose fixture env/production secrets. Reinspect actual container state before reuse; cleanup may have changed it.

## Review and external release gates

R2 independent protocol review accepted `e0ff654c`, report `docs/reviews/identity-v2-protocol.md`; later narrow lint/toolchain impact accepted through `83bb2143` (report commit integrated `4cd49183`). New compatibility/files/fixture delta requires independent review and final SHA confirmation. Minor report correction: directory check at HEAD95327500 was precommit/working-tree evidence, not an attested clean 415e tree; HEAD alone cannot prove when initializer cleanup was present.

R1 was abandoned after service content restriction, not a completed second independent review. Three confirmed findings were fixed (first complete LDAP absence disables access; fresh upstream auth_time at finish/activate; RTC revocation enumeration bounds), but this is not R1 signoff. Do not retry/bypass the service restriction or present R2 continuation as a second review. Required second complete independent security/protocol signoff remains unresolved.

`docs/plans/identity-v2-operator-preflight.md` records external blockers: authoritative platform manifest source unknown, Vault writer/key custody/backup unknown, API/web route configuration missing identity routes, ingress request/error logs may leak query credentials, identity-aware rollback required. Read-only preflight only; no production changes. Canonical issuer https://app.calab.ru. Actual Microsoft AD/Entra/ADFS environment and native OS roundtrip remain unverified; generic Keycloak/fake LDAP tests are not those claims. Two user questions (platform source and Microsoft environment) remain unanswered.

Release only after exact source tests/reviews and deployment gates: main CI, version tag workflows, published Release/feed/installers/checksums, API/web version and smoke. No push/tag/deploy performed. Release announcement requires explicit messaging authorization; repository checklist alone does not override tool messaging instructions.
