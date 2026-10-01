# Identity 2.0 route and channel enforcement audit

Audit date: 2026-10-01. Source baseline: `99a60fc5` (isolated `identity-v2-qa-env`, based on identity-delivery).
This is an implementation handoff and coverage audit, **not evidence that SSO enforcement exists**.
No production code, SQL or proto was changed here. Gate implementation/proof execution below remain
**planned**, aligned with normative ADR-0054 and `release-2.0-identity.md` at identity-delivery
**`5f8b2caa`** (149f1f64 plus clarifications). This audit does not choose new authority,
bot exemption, recovery or lease semantics. Existing design inputs `next-release-*.md` in the
SSO/AD, OAuth-provider and identity-security design trees were read as proposals only.

## Baseline findings and integration boundary

The registered literal census and `app.botRoutes` contain 266 unique patterns. `TestBotRouteTable`
also exercises registered routes at runtime, including RTC-disabled registration. It is a **bot
classification test**, not an SSO test. Run `python3 infra/identity-test/route-inventory.py` to reject
literal/table/document drift; computed routes still require the runtime route-table test and manual
review. A new identity route must receive an explicit classification; extending broad prefix rules
without reviewing its resource and operation is insufficient.

Current `app.go:private` is auth -> bot gate -> request-local permission resolver -> suspension guard.
`auth.Identity` carries user/session/bot identity, not a workspace assurance decision. Room/board
permissions enforce membership and bits, not SSO provenance. Thus all proposed SSO cases are absent
at this baseline even when existing permission tests pass. The integration worker owns wiring and
targeted production/test changes; this worker only provides inventory and reusable environment.

The following proof IDs apply to **every method** in the census, including GET/HEAD equivalents,
downloads, export and cleanup mutations. Verify denial before disclosing data or committing effects;
check response shape, DB state, blobs, outbox and gateway/SFU delivery. Exact status/reason and time
budgets come from the frozen ADR, not these labels: read/WS/RTC policy lease ≤30s and never past
the nearest proof deadline; management local and (where required) corporate proofs ≤5min;
ordinary corporate assurance ≤1h. Provider issue/refresh/UserInfo use fresh DB decisions, no
positive cache. RPC failure cannot prolong protected delivery beyond the lease.

| Proof | Planned gate and required evidence |
|---|---|
| P0 | Technical public/404 endpoints remain public; health/metrics contain no identity secrets or tenant payload. Caddy's existing public exposure rules still apply. |
| G0 | Global local-account authority required for credentials, recovery, own-session listing/revoke-other/logout-all, personal notes, DM, user notes, CalDAV, workspace creation and superadmin. A scoped A session for a user who owns B/is superadmin cannot exercise these paths. Public local login/reset remains available without manufacturing A assurance. |
| G1 | Refresh/logout use the presented session's immutable authority and correct cookie namespace; refresh cannot widen scope, renew assurance or revoke another account/session. Cover cookie CSRF, bearer refresh, replay/reuse, lost-response retry and expired/revoked proof. |
| W0 | Resolve target workspace from DB, require current authority/assurance plus existing bits. A valid A session cannot operate B; local password without A assurance cannot bypass enforced A. Membership alone, owner, administrator and MANAGE_INTEGRATIONS are not substitutes for assurance. Membership control paths cannot grant data access merely by accepting an invite. |
| R0 | Resolve the actual room/category/message/board/task/app/pack/sticker/bot parent from DB before reading/writing. Validate all nested IDs against the same parent; target in JSON/query cannot override it. Include archived task/temp-room paths, task short ID, activity/CSV, closed-room/board restrictions, search/unfurl and batch ordering. Resolve both source and destination when forwarding/moving/reparenting. |
| F0 | Gate file ownership and each allowed read path before uploader/avatar/icon/sticker shortcuts. Cover attachment, unattached upload, personal DM/notes attachment, avatar, workspace icon/badge/background/sound/app icon/sticker and forwarded references. GET/HEAD, Range/If-None-Match, thumbnail and large preview must not return bytes or cache-validity information when denied. |
| A0 | Aggregate/list/profile results are filtered by per-item workspace authority and assurance, with pagination/counts/read states/notifications consistent with that filter. A scoped A session exposes only the approved minimal profile (no superadmin), no B membership or personal resources. Local session with A revoked retains permitted B. |
| C0 | Public invite/room-link/signed RSVP resolves the target workspace and applies its public-capability policy before preview, join, grant or decision. Enforced A cannot be bypassed through existing guest, pending admission, promote, open join, email verification/auto-accept or reused pre-enforcement link. Tests must assert no accidental account/member/override/admission/consent creation. |
| M0 | Bots retain their existing separate machine permissions model plus workspace suspension, per ADR-0054; they do not acquire human SSO/assurance/OAuth/recovery capabilities. Existing bot allow/deny and human-only routes stay enforced; OAuth provider tokens/ID tokens/LiveKit tokens never fall back to first-party auth or bot auth. Verify existing cross-workspace bot DM/webhook semantics without granting scoped human authority to a machine. |
| GW | Fresh authority applies to IDENTIFY, READY, subscriptions, each live event, pending events, presence/typing and local/remote RESUME replay. Revocation after buffering must prevent protected A replay; B survives. Lost pubsub and dependency outage cannot indefinitely extend stale delivery. |
| RTC | Check principal and target before join, grant/update, stream/camera/SIP/move; recheck at admission/webhook/reconcile, and evict affected participants on expiry/revoke. Test old still-valid join JWT, missed webhook, queued move token, grant source bits and retry after SFU outage. Target only affected workspace/session/device; unrelated B/DM remains according to authority. |

## Exact integration callsites beyond the route wrapper

Paths in this table are under `apps/server/internal/`; registration file/line for every REST route is
in the census. These are concrete baseline callsites, not invented new API names.

| Surface | Callsites to gate | Required targeted proof / existing fixture to extend |
|---|---|---|
| Principal/middleware | `auth/middleware.go:Service.Require, Authenticate, AuthenticateToken`; `auth/tokens.go`; `auth/service.go` session issue/refresh; `app/app.go:private`; `app/botroutes.go:botGate`; `auth/credentials.go`, `email.go` | G0/G1/M0; preserve refresh retry behavior and local-account baseline; extension of `TestChangeCredentials`, `TestRefreshRotationAndReuseDetection`, `TestRefreshLostAnswerReplay`, `TestWebCookieAuth`. |
| Resource identity | `perm/resolver.go:Resolver.Workspace, Room, ReadRoom`; `perm/board_resolver.go:Resolver.Board, taskRoom`; `moderation/moderation.go:Guard` | W0/R0; membership/bits remain additional requirements. Do not turn request-only assurance into a user-ID cache or silently authorize unclassified paths. `TestPermissionMatrixREST`, `TestRestrictedRoomMatrix`, `TestRolesV2ClosedBoard` remain useful baseline. |
| Membership bypasses | `workspaces/workspaces.go` create/join/invite/promote/member handlers; `workspaces/email_invites.go:boundInvite, AcceptEmailInvites, addMember`; auth email-verified callback in `app/app.go`; `guests/guests.go:preview, join, grant`; `guests/admissions.go:knock, decide, OwnAdmissions, FillAdmissions` | C0/W0; all ingress paths with same enforced A and unchanged B. Existing `invite_flow`, `admission`, `email`, `p05`, `suspend_ban` integration fixtures are not SSO proof. |
| Lists/snapshots/search | `workspaces/workspaces.go:Snapshot` and list/get/discover/member profile; `messages/mentions.go:listMentions`; `messages/messages.go:searchWorkspace`; calendar today/freebusy/suggest; board search/activity/CSV; `unfurl/service.go` internal URL lookup and signed image | A0/R0; never expose forbidden names, snippets, totals, thumbnails, invite lookup results or user attributes through aggregate endpoints. `TestMessagesAndFiles`, mentions/calendar/freebusy/boards fixtures. |
| Files and recordings | `files/files.go:UploadInto, uploadDM, CanRead, load, download, thumbnail, serve`; `messages/forward.go:forward, forwardable`; `recording/` download/transcript/forwarded-copy handlers | F0/R0; `CanRead` currently returns true immediately for uploader, and avatar/icons/stickers have distinct shortcuts. Enforce before those returns and before Range/ETag/body streaming; extend files/thumb/forward/recording fixtures. |
| READY | `gateway/handler.go:identify, buildReady`; `gateway/hub.go:register, joinWorkspace, fillLive`; `pbconv` profile conversion | GW/A0; `buildReady` independently loads `calls.Current`, `ListUserWorkspaces`, admissions, active meetings, DMs, notes, peer/read states and workspace notification settings. Filtering only `ready.Workspaces` leaves other fields exposed. Extend `TestGatewayFlow`, `TestRestrictedRoomGateway`, DM/read-state/admission fixtures. |
| User fanout | `events/events.go:Redis.User, UserChannel`; `gateway/hub.go:onMessage, routeUser`; `session.go:dispatchEnc, emit, flushPending, resumeMany` | GW; `routeUser` currently targets every session of a user. Test same user with local+A+B/scoped-A sessions; `WorkspaceCreate` currently joins all sessions and queues snapshots. Filter before subscription, encoding/queue and final emission. |
| User event producers | `boards/notify.go:notifyDirect, notifySubscribers`, task notification updates; `calendar/sweep.go` reminders; `messages/receipts.go`, `messages/messages.go`, `messages/forward.go` read-state updates; `workspaces/notifications.go`; `guests/admissions.go:publishDecided`; `rtc/move.go:publishMoved`, `rtc/devices.go`; `bots/bots.go` owner notifications; `calls/calls.go` ring/action | GW/W0/G0/M0; inspect workspace/room/task attribution even when event envelope has only user or room ID. Do not send a revoked A event/token to another scoped session solely because user IDs match. Also cover async outbox dispatch after revoke. |
| Workspace/presence | `gateway/hub.go:routeWorkspace, routeLocked, reviewRooms, dispatchGained, toAll, toViewers, announcePresence`; `gateway/state.go`; `gateway/boards.go`, `calendar.go`; `handler.go:typing, setSubscribed, dmPeer` | GW; workspace policy lease supplements cached room/board viewer bits. Test presence/user updates, typing, visibility gains, role updates, notifications and admission events, not just messages. |
| Replay/takeover | `gateway/handler.go:resume, takeover, replayLocal, replayTakenOver, transcodeAll`; `gateway/buffer.go:entries, meta`; `session.go:bufferWriter, attachLocked, flushPending` | GW; replay currently transcodes historic entries without fresh per-event workspace authorization. Revoke after append, disconnect, then same-instance and second-hub takeover RESUME; assert no A event, unchanged valid B, proper seq/re-identify semantics. |
| Dependency failure | `auth/sessioncheck.go:CheckSession`; `gateway/handler.go:sessionRevoked`; `gateway/hub.go:invalidateAll, onControl` | GW/W0; REST has marker plus bounded DB recheck; gateway heartbeat currently keeps socket on recheck error. Test dropped invalidation, stale positive lease, DB/Valkey error with fake clock and bounded freeze; do not borrow first-party revocation cache deadlines as identity deadlines. |
| RTC issuance/reconnect | `rtc/rtc.go:join, requestStream, pushGrant, grant, voiceSelf`; `rtc/camera.go`; `rtc/move.go:moveMember, publishMoved`; `rtc/webhook.go:participantJoined`; `rtc/dm.go`; `sip/` handlers | RTC; source/destination assurance, unchanged bits in grant, rejected pre-revoke token at reconnect, no scoped access to personal DM voice. Mock adapter verifies exact UpdateParticipant/RemoveParticipant calls. |
| RTC invalidation | `rtc/sync.go:SyncPublisher, sync, resync, disconnect, Reconcile, RunReconcile`; `rtc/devices.go:takeOutDevice`; `auth/sessioncheck.go`; app auth revoke/RTC hooks | RTC; event-driven sync alone does not expire assurance. Required durable invalidation/reconciliation/lease deadline is frozen-ADR work; test lost invalidation/webhook and unhealthy SFU retry, measured eviction and no B disconnect. Existing scope/sync/leave/device tests are baseline only. |
| Global operations | `users/users.go:get, update`; `auth/credentials.go` and private handlers; `plans/admin.go:guard`; `app/app.go` superadmin resolver; `dms/`, `notes/`, `caldav/`, `calls/` | G0/A0; linked superadmin user with scoped A identity cannot gain global admin or personal authority. Fresh independent local proof for privileged operations must be tested at the final integration commit. |
| Machine/outbox | `auth/bots.go`; `app/botroutes.go`; `bots/webhook.go` publisher and queued delivery; `bots/bots.go` credential rotation/revoke; `messages/inline.go`; signed SFU webhook | M0/RTC; distinguish bot token, provider access/refresh/ID token, first-party token and signed SFU hook. Verify rotation/revoke, home/secondary workspace and stale queued webhook policy against ADR. |
| Asynchronous notifications | `calendar/sweep.go` reminder recipient selection, `boards/notify.go:sendNotices`, `mail/mail.go` queued templates/delivery, `workspaces/email_invites.go` invitation notification | GW/W0/C0; verify recipient/member/policy attribution and queued payload handling after revoke, including email and webhook channels that bypass an active user's REST request. Local-account recovery mail remains a separate G0 capability. |

## Route census (planned identity classifications)

`public` bot decision means public handler; it is **not** permission to accept a bot token.
`resource-id` includes workspace-backed and personal variants; resolve from DB, then select W0 or G0.
For R0/F0 plus cross-workspace operations, apply all relevant proof IDs, not only the abbreviated row.
`aggregate` includes each item's permission rules; lists must not leak an excluded workspace via counts.
Every baseline bot-allow row additionally needs M0; bot-deny rows must remain denied to machines.
All classes below are audit decisions for review, not an implemented identity route table.

<!-- ROUTES-BEGIN -->
Baseline census: **266 unique patterns**, each with source, proposed gate class and proof ID.

| Pattern | Registration source | Baseline bot decision | Planned identity gate | Proof |
|---|---|---|---|---|
| `/api/` | `apps/server/internal/app/app.go:408` | public | public | P0 |
| `DELETE /api/boards/{id}` | `apps/server/internal/boards/boards.go:68` | allow | resource-id | R0 |
| `DELETE /api/boards/{id}/labels/{sid}` | `apps/server/internal/boards/boards.go:78` | allow | resource-id | R0 |
| `DELETE /api/boards/{id}/milestones/{sid}` | `apps/server/internal/boards/boards.go:81` | allow | resource-id | R0 |
| `DELETE /api/boards/{id}/statuses/{sid}` | `apps/server/internal/boards/boards.go:75` | allow | resource-id | R0 |
| `DELETE /api/boards/{id}/views/{sid}` | `apps/server/internal/boards/boards.go:85` | allow | resource-id | R0 |
| `DELETE /api/bots/me/webhook` | `apps/server/internal/bots/bots.go:105` | allow | resource-id | R0 |
| `DELETE /api/categories/{id}` | `apps/server/internal/rooms/categories.go:23` | allow | resource-id | R0 |
| `DELETE /api/events/{id}` | `apps/server/internal/calendar/calendar.go:95` | allow | resource-id | R0 |
| `DELETE /api/me/blocked-bots/{id}` | `apps/server/internal/bots/bots.go:109` | deny | global-account | G0 |
| `DELETE /api/me/caldav` | `apps/server/internal/caldav/service.go:129` | deny | global-account | G0 |
| `DELETE /api/me/sessions/{id}` | `apps/server/internal/auth/handlers.go:115` | deny | global-account | G0 |
| `DELETE /api/me/sticker-packs/{id}` | `apps/server/internal/stickers/stickers.go:81` | allow | global-account | G0 |
| `DELETE /api/messages/{id}` | `apps/server/internal/messages/messages.go:65` | allow | resource-id | R0 |
| `DELETE /api/messages/{id}/pin` | `apps/server/internal/messages/messages.go:72` | allow | resource-id | R0 |
| `DELETE /api/messages/{id}/reactions/{emoji}` | `apps/server/internal/messages/messages.go:70` | allow | resource-id | R0 |
| `DELETE /api/notes/{id}` | `apps/server/internal/notes/notes.go:57` | deny | personal-resource | G0+M0 |
| `DELETE /api/rooms/{id}` | `apps/server/internal/rooms/rooms.go:62` | allow | resource-id | R0 |
| `DELETE /api/rooms/{id}/admissions/me` | `apps/server/internal/guests/guests.go:73` | deny | resource-id | R0 |
| `DELETE /api/rooms/{id}/calls/{cid}` | `apps/server/internal/sip/sip.go:129` | allow | resource-id | R0 |
| `DELETE /api/rooms/{id}/invites/{inviteId}` | `apps/server/internal/guests/guests.go:70` | deny | resource-id | R0 |
| `DELETE /api/rooms/{id}/recordings/{rid}` | `apps/server/internal/recording/recording.go:139` | deny | resource-id | R0 |
| `DELETE /api/sticker-packs/{id}` | `apps/server/internal/stickers/stickers.go:73` | allow | resource-id | R0 |
| `DELETE /api/stickers/{id}` | `apps/server/internal/stickers/stickers.go:77` | allow | resource-id | R0 |
| `DELETE /api/tasks/{id}/relations` | `apps/server/internal/boards/boards.go:98` | allow | resource-id | R0 |
| `DELETE /api/users/{id}/note` | `apps/server/internal/users/users.go:57` | deny | global-account | G0 |
| `DELETE /api/workspace-apps/{appId}` | `apps/server/internal/workspaces/apps.go:35` | deny | resource-id | R0 |
| `DELETE /api/workspaces/{id}` | `apps/server/internal/workspaces/workspaces.go:90` | deny | workspace-id | W0 |
| `DELETE /api/workspaces/{id}/backgrounds/{bgId}` | `apps/server/internal/workspaces/backgrounds.go:40` | deny | workspace-id | W0 |
| `DELETE /api/workspaces/{id}/badges/{badgeId}` | `apps/server/internal/workspaces/badges.go:31` | allow | workspace-id | W0 |
| `DELETE /api/workspaces/{id}/bans/{userId}` | `apps/server/internal/workspaces/bans.go:24` | allow | workspace-id | W0 |
| `DELETE /api/workspaces/{id}/bots/{botId}` | `apps/server/internal/bots/bots.go:94` | deny | workspace-id | W0 |
| `DELETE /api/workspaces/{id}/bots/{botId}/avatar` | `apps/server/internal/bots/bots.go:98` | deny | workspace-id | W0 |
| `DELETE /api/workspaces/{id}/bots/{botId}/token` | `apps/server/internal/bots/bots.go:96` | deny | workspace-id | W0 |
| `DELETE /api/workspaces/{id}/integrations/gptunnel` | `apps/server/internal/recording/recording.go:133` | deny | workspace-id | W0 |
| `DELETE /api/workspaces/{id}/invites/email/{inviteId}` | `apps/server/internal/workspaces/email_invites.go:56` | allow | workspace-id | W0 |
| `DELETE /api/workspaces/{id}/invites/{inviteId}` | `apps/server/internal/workspaces/workspaces.go:95` | allow | workspace-id | W0 |
| `DELETE /api/workspaces/{id}/members/{userId}` | `apps/server/internal/workspaces/workspaces.go:99` | allow | workspace-id | W0 |
| `DELETE /api/workspaces/{id}/roles/{roleId}` | `apps/server/internal/workspaces/roles.go:34` | allow | workspace-id | W0 |
| `DELETE /api/workspaces/{id}/sounds/{soundId}` | `apps/server/internal/sounds/sounds.go:73` | allow | workspace-id | W0 |
| `GET /api/admin/users/{id}/storage-quota` | `apps/server/internal/plans/admin.go:51` | deny | global-admin | G0 |
| `GET /api/admin/workspaces` | `apps/server/internal/plans/admin.go:46` | deny | global-admin | G0 |
| `GET /api/admin/workspaces/{id}` | `apps/server/internal/plans/admin.go:47` | deny | global-admin | G0 |
| `GET /api/admin/workspaces/{id}/plan/log` | `apps/server/internal/plans/admin.go:49` | deny | global-admin | G0 |
| `GET /api/boards/{id}` | `apps/server/internal/boards/boards.go:66` | allow | resource-id | R0 |
| `GET /api/boards/{id}/activity` | `apps/server/internal/boards/boards.go:87` | allow | resource-id | R0 |
| `GET /api/boards/{id}/permissions` | `apps/server/internal/boards/boards.go:71` | allow | resource-id | R0 |
| `GET /api/boards/{id}/tasks` | `apps/server/internal/boards/boards.go:88` | allow | resource-id | R0 |
| `GET /api/boards/{id}/views` | `apps/server/internal/boards/boards.go:82` | allow | resource-id | R0 |
| `GET /api/bots/me` | `apps/server/internal/bots/bots.go:100` | allow | resource-id | R0 |
| `GET /api/bots/me/webhook` | `apps/server/internal/bots/bots.go:103` | allow | resource-id | R0 |
| `GET /api/bots/{ref}` | `apps/server/internal/bots/bots.go:99` | deny | resource-id | R0 |
| `GET /api/dms` | `apps/server/internal/dms/dms.go:49` | allow | personal-resource | G0+M0 |
| `GET /api/dms/candidates` | `apps/server/internal/dms/dms.go:50` | allow | personal-resource | G0+M0 |
| `GET /api/event-rsvp` | `apps/server/internal/calendar/calendar.go:100` | public | capability-target | C0 |
| `GET /api/events/{id}` | `apps/server/internal/calendar/calendar.go:93` | allow | resource-id | R0 |
| `GET /api/files/{id}` | `apps/server/internal/files/files.go:140` | allow | file-id | F0 |
| `GET /api/files/{id}/thumbnail` | `apps/server/internal/files/files.go:141` | allow | file-id | F0 |
| `GET /api/invites/{code}` | `apps/server/internal/workspaces/workspaces.go:102` | public | capability-target | C0 |
| `GET /api/me` | `apps/server/internal/users/users.go:52` | allow | aggregate-profile | A0 |
| `GET /api/me/blocked-bots` | `apps/server/internal/bots/bots.go:107` | deny | global-account | G0 |
| `GET /api/me/caldav` | `apps/server/internal/caldav/service.go:124` | deny | global-account | G0 |
| `GET /api/me/events/today` | `apps/server/internal/calendar/calendar.go:97` | deny | aggregate | A0 |
| `GET /api/me/external-events` | `apps/server/internal/caldav/service.go:128` | deny | global-account | G0 |
| `GET /api/me/mentions` | `apps/server/internal/messages/messages.go:74` | allow | aggregate | A0 |
| `GET /api/me/sessions` | `apps/server/internal/auth/handlers.go:114` | deny | global-account | G0 |
| `GET /api/me/sticker-packs` | `apps/server/internal/stickers/stickers.go:78` | allow | aggregate | A0 |
| `GET /api/me/tasks` | `apps/server/internal/boards/boards.go:103` | allow | global-account | G0 |
| `GET /api/messages/{id}/reactions/{emoji}` | `apps/server/internal/messages/messages.go:68` | allow | resource-id | R0 |
| `GET /api/notes` | `apps/server/internal/notes/notes.go:54` | deny | personal-resource | G0+M0 |
| `GET /api/room-invites/{code}` | `apps/server/internal/guests/guests.go:74` | public | capability-target | C0 |
| `GET /api/rooms/{id}` | `apps/server/internal/rooms/rooms.go:60` | allow | resource-id | R0 |
| `GET /api/rooms/{id}/admissions` | `apps/server/internal/guests/guests.go:71` | allow | resource-id | R0 |
| `GET /api/rooms/{id}/bot-commands` | `apps/server/internal/bots/bots.go:106` | allow | resource-id | R0 |
| `GET /api/rooms/{id}/invites` | `apps/server/internal/guests/guests.go:68` | deny | resource-id | R0 |
| `GET /api/rooms/{id}/messages` | `apps/server/internal/messages/messages.go:59` | allow | resource-id | R0 |
| `GET /api/rooms/{id}/messages/{messageId}` | `apps/server/internal/messages/messages.go:60` | allow | resource-id | R0 |
| `GET /api/rooms/{id}/pins` | `apps/server/internal/messages/messages.go:73` | allow | resource-id | R0 |
| `GET /api/rooms/{id}/recordings/{rid}/transcript` | `apps/server/internal/recording/recording.go:138` | allow | resource-id | R0 |
| `GET /api/sticker-packs/{id}` | `apps/server/internal/stickers/stickers.go:71` | allow | resource-id | R0 |
| `GET /api/t/{key}` | `apps/server/internal/boards/boards.go:102` | allow | resource-id | R0 |
| `GET /api/tasks/{id}` | `apps/server/internal/boards/boards.go:90` | allow | resource-id | R0 |
| `GET /api/tasks/{id}/activity` | `apps/server/internal/boards/boards.go:101` | allow | resource-id | R0 |
| `GET /api/unfurl` | `apps/server/internal/unfurl/service.go:66` | deny | external-or-resource | R0 |
| `GET /api/unfurl/image` | `apps/server/internal/unfurl/service.go:67` | deny | external-or-resource | R0 |
| `GET /api/users/{id}/note` | `apps/server/internal/users/users.go:55` | deny | global-account | G0 |
| `GET /api/version` | `apps/server/internal/buildinfo/buildinfo.go:57` | public | public | P0 |
| `GET /api/workspaces` | `apps/server/internal/workspaces/workspaces.go:86` | allow | aggregate | A0 |
| `GET /api/workspaces/discover` | `apps/server/internal/workspaces/workspaces.go:87` | deny | aggregate | A0 |
| `GET /api/workspaces/{id}` | `apps/server/internal/workspaces/workspaces.go:88` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/apps` | `apps/server/internal/workspaces/apps.go:32` | deny | workspace-id | W0 |
| `GET /api/workspaces/{id}/backgrounds` | `apps/server/internal/workspaces/backgrounds.go:37` | deny | workspace-id | W0 |
| `GET /api/workspaces/{id}/badges` | `apps/server/internal/workspaces/badges.go:28` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/bans` | `apps/server/internal/workspaces/bans.go:22` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/birthdays` | `apps/server/internal/birthdays/birthdays.go:43` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/boards` | `apps/server/internal/boards/boards.go:64` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/bots` | `apps/server/internal/bots/bots.go:92` | deny | workspace-id | W0 |
| `GET /api/workspaces/{id}/calls` | `apps/server/internal/sip/sip.go:127` | deny | workspace-id | W0 |
| `GET /api/workspaces/{id}/categories` | `apps/server/internal/rooms/categories.go:20` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/events` | `apps/server/internal/calendar/calendar.go:91` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/freebusy` | `apps/server/internal/calendar/calendar.go:98` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/integrations/gptunnel` | `apps/server/internal/recording/recording.go:131` | deny | workspace-id | W0 |
| `GET /api/workspaces/{id}/invites` | `apps/server/internal/workspaces/workspaces.go:93` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/invites/email` | `apps/server/internal/workspaces/email_invites.go:55` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/members` | `apps/server/internal/workspaces/workspaces.go:96` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/members/birthdays` | `apps/server/internal/workspaces/birthdays.go:21` | deny | workspace-id | W0 |
| `GET /api/workspaces/{id}/members/{userId}` | `apps/server/internal/workspaces/workspaces.go:97` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/messages/search` | `apps/server/internal/messages/messages.go:67` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/roles` | `apps/server/internal/workspaces/roles.go:30` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/rooms` | `apps/server/internal/rooms/rooms.go:58` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/sip` | `apps/server/internal/sip/sip.go:124` | deny | workspace-id | W0 |
| `GET /api/workspaces/{id}/sounds` | `apps/server/internal/sounds/sounds.go:70` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/sticker-packs` | `apps/server/internal/stickers/stickers.go:69` | allow | workspace-id | W0 |
| `GET /api/workspaces/{id}/tasks/search` | `apps/server/internal/boards/boards.go:104` | allow | workspace-id | W0 |
| `GET /gateway` | `apps/server/internal/app/app.go:306` | public | gateway | GW |
| `GET /healthz` | `apps/server/internal/health/health.go:19` | public | public | P0 |
| `GET /metrics` | `apps/server/internal/app/app.go:305` | public | public | P0 |
| `GET /readyz` | `apps/server/internal/health/health.go:23` | public | public | P0 |
| `PATCH /api/boards/{id}` | `apps/server/internal/boards/boards.go:67` | allow | resource-id | R0 |
| `PATCH /api/boards/{id}/labels/{sid}` | `apps/server/internal/boards/boards.go:77` | allow | resource-id | R0 |
| `PATCH /api/boards/{id}/milestones/{sid}` | `apps/server/internal/boards/boards.go:80` | allow | resource-id | R0 |
| `PATCH /api/boards/{id}/statuses/{sid}` | `apps/server/internal/boards/boards.go:74` | allow | resource-id | R0 |
| `PATCH /api/boards/{id}/views/{sid}` | `apps/server/internal/boards/boards.go:84` | allow | resource-id | R0 |
| `PATCH /api/bots/me` | `apps/server/internal/bots/bots.go:101` | allow | resource-id | R0 |
| `PATCH /api/categories/{id}` | `apps/server/internal/rooms/categories.go:22` | allow | resource-id | R0 |
| `PATCH /api/dms/{id}/state` | `apps/server/internal/dms/dms.go:51` | deny | personal-resource | G0+M0 |
| `PATCH /api/events/{id}` | `apps/server/internal/calendar/calendar.go:94` | allow | resource-id | R0 |
| `PATCH /api/me` | `apps/server/internal/users/users.go:53` | allow | global-account | G0 |
| `PATCH /api/me/caldav` | `apps/server/internal/caldav/service.go:127` | deny | global-account | G0 |
| `PATCH /api/me/email` | `apps/server/internal/auth/handlers.go:117` | deny | global-account | G0 |
| `PATCH /api/me/password` | `apps/server/internal/auth/handlers.go:116` | deny | global-account | G0 |
| `PATCH /api/me/status` | `apps/server/internal/users/users.go:54` | deny | global-account | G0 |
| `PATCH /api/messages/{id}` | `apps/server/internal/messages/messages.go:64` | allow | resource-id | R0 |
| `PATCH /api/notes/{id}` | `apps/server/internal/notes/notes.go:56` | deny | personal-resource | G0+M0 |
| `PATCH /api/rooms/{id}` | `apps/server/internal/rooms/rooms.go:61` | allow | resource-id | R0 |
| `PATCH /api/rooms/{id}/invites/{inviteId}` | `apps/server/internal/guests/guests.go:69` | deny | resource-id | R0 |
| `PATCH /api/rooms/{id}/voice-status` | `apps/server/internal/rtc/rtc.go:96` | allow | resource-id | R0 |
| `PATCH /api/sticker-packs/{id}` | `apps/server/internal/stickers/stickers.go:72` | allow | resource-id | R0 |
| `PATCH /api/stickers/{id}` | `apps/server/internal/stickers/stickers.go:76` | allow | resource-id | R0 |
| `PATCH /api/tasks/{id}` | `apps/server/internal/boards/boards.go:91` | allow | resource-id | R0 |
| `PATCH /api/voice/self` | `apps/server/internal/rtc/rtc.go:95` | allow | active-voice-target | RTC |
| `PATCH /api/workspace-apps/{appId}` | `apps/server/internal/workspaces/apps.go:34` | deny | resource-id | R0 |
| `PATCH /api/workspaces/{id}` | `apps/server/internal/workspaces/workspaces.go:89` | allow | workspace-id | W0 |
| `PATCH /api/workspaces/{id}/backgrounds/{bgId}` | `apps/server/internal/workspaces/backgrounds.go:39` | deny | workspace-id | W0 |
| `PATCH /api/workspaces/{id}/badges/{badgeId}` | `apps/server/internal/workspaces/badges.go:30` | allow | workspace-id | W0 |
| `PATCH /api/workspaces/{id}/members/{userId}` | `apps/server/internal/workspaces/workspaces.go:98` | allow | workspace-id | W0 |
| `PATCH /api/workspaces/{id}/members/{userId}/birthday` | `apps/server/internal/workspaces/birthdays.go:22` | deny | workspace-id | W0 |
| `PATCH /api/workspaces/{id}/roles/{roleId}` | `apps/server/internal/workspaces/roles.go:33` | allow | workspace-id | W0 |
| `PATCH /api/workspaces/{id}/sounds/{soundId}` | `apps/server/internal/sounds/sounds.go:72` | allow | workspace-id | W0 |
| `POST /api/auth/login` | `apps/server/internal/auth/handlers.go:104` | public | local-proof | G0 |
| `POST /api/auth/logout` | `apps/server/internal/auth/handlers.go:107` | public | own-session | G1 |
| `POST /api/auth/password/forgot` | `apps/server/internal/auth/handlers.go:108` | public | local-proof | G0 |
| `POST /api/auth/password/reset` | `apps/server/internal/auth/handlers.go:109` | public | local-proof | G0 |
| `POST /api/auth/refresh` | `apps/server/internal/auth/handlers.go:105` | public | own-session | G1 |
| `POST /api/auth/register` | `apps/server/internal/auth/handlers.go:103` | public | local-proof | G0 |
| `POST /api/auth/verify` | `apps/server/internal/auth/handlers.go:119` | deny | global-account | G0 |
| `POST /api/auth/verify/send` | `apps/server/internal/auth/handlers.go:118` | deny | global-account | G0 |
| `POST /api/boards/{id}/files` | `apps/server/internal/boards/boards.go:86` | allow | resource-id | R0 |
| `POST /api/boards/{id}/labels` | `apps/server/internal/boards/boards.go:76` | allow | resource-id | R0 |
| `POST /api/boards/{id}/milestones` | `apps/server/internal/boards/boards.go:79` | allow | resource-id | R0 |
| `POST /api/boards/{id}/restore` | `apps/server/internal/boards/boards.go:69` | allow | resource-id | R0 |
| `POST /api/boards/{id}/statuses` | `apps/server/internal/boards/boards.go:73` | allow | resource-id | R0 |
| `POST /api/boards/{id}/tasks` | `apps/server/internal/boards/boards.go:89` | allow | resource-id | R0 |
| `POST /api/boards/{id}/views` | `apps/server/internal/boards/boards.go:83` | allow | resource-id | R0 |
| `POST /api/calls/{id}/accept` | `apps/server/internal/calls/calls.go:114` | deny | personal-resource | G0+M0 |
| `POST /api/calls/{id}/cancel` | `apps/server/internal/calls/calls.go:116` | deny | personal-resource | G0+M0 |
| `POST /api/calls/{id}/decline` | `apps/server/internal/calls/calls.go:115` | deny | personal-resource | G0+M0 |
| `POST /api/calls/{id}/hangup` | `apps/server/internal/calls/calls.go:117` | deny | personal-resource | G0+M0 |
| `POST /api/dms` | `apps/server/internal/dms/dms.go:48` | allow | personal-resource | G0+M0 |
| `POST /api/dms/{id}/call` | `apps/server/internal/calls/calls.go:113` | deny | personal-resource | G0+M0 |
| `POST /api/dms/{id}/files` | `apps/server/internal/files/files.go:137` | allow | personal-resource | G0+M0 |
| `POST /api/event-rsvp` | `apps/server/internal/calendar/calendar.go:101` | public | capability-target | C0 |
| `POST /api/files/convert` | `apps/server/internal/files/files.go:139` | deny | file-id | F0 |
| `POST /api/invites/{code}/join` | `apps/server/internal/moderation/moderation.go:75` | deny | capability-target | C0 |
| `POST /api/me/avatar` | `apps/server/internal/files/files.go:138` | allow | global-account | G0 |
| `POST /api/me/blocked-bots/{id}` | `apps/server/internal/bots/bots.go:108` | deny | global-account | G0 |
| `POST /api/me/caldav` | `apps/server/internal/caldav/service.go:125` | deny | global-account | G0 |
| `POST /api/me/caldav/sync` | `apps/server/internal/caldav/service.go:130` | deny | global-account | G0 |
| `POST /api/messages/{id}/interactions` | `apps/server/internal/messages/messages.go:63` | deny | resource-id | R0 |
| `POST /api/notes` | `apps/server/internal/notes/notes.go:55` | deny | personal-resource | G0+M0 |
| `POST /api/room-invites/{code}/join` | `apps/server/internal/guests/guests.go:75` | public | capability-target | C0 |
| `POST /api/rooms/{id}/admissions/{userId}` | `apps/server/internal/guests/guests.go:72` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/calls` | `apps/server/internal/moderation/moderation.go:63` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/camera/request` | `apps/server/internal/moderation/moderation.go:59` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/camera/stop` | `apps/server/internal/rtc/rtc.go:92` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/invites` | `apps/server/internal/guests/guests.go:67` | deny | resource-id | R0 |
| `POST /api/rooms/{id}/join` | `apps/server/internal/moderation/moderation.go:56` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/messages` | `apps/server/internal/messages/messages.go:61` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/messages/{mid}/forward` | `apps/server/internal/messages/messages.go:62` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/recording/start` | `apps/server/internal/moderation/moderation.go:62` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/recording/stop` | `apps/server/internal/recording/recording.go:135` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/recordings/{rid}/recheck` | `apps/server/internal/moderation/moderation.go:65` | deny | resource-id | R0 |
| `POST /api/rooms/{id}/recordings/{rid}/reupload` | `apps/server/internal/moderation/moderation.go:66` | deny | resource-id | R0 |
| `POST /api/rooms/{id}/sounds/play` | `apps/server/internal/moderation/moderation.go:60` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/stream/request` | `apps/server/internal/moderation/moderation.go:58` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/voice/leave` | `apps/server/internal/rtc/rtc.go:89` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/voice/{userId}/allow-camera` | `apps/server/internal/moderation/moderation.go:61` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/voice/{userId}/disconnect` | `apps/server/internal/rtc/rtc.go:99` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/voice/{userId}/move` | `apps/server/internal/moderation/moderation.go:57` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/voice/{userId}/mute` | `apps/server/internal/rtc/rtc.go:97` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/voice/{userId}/stop-camera` | `apps/server/internal/rtc/rtc.go:93` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/voice/{userId}/stop-stream` | `apps/server/internal/rtc/rtc.go:100` | allow | resource-id | R0 |
| `POST /api/rooms/{id}/voice/{userId}/unmute` | `apps/server/internal/rtc/rtc.go:98` | allow | resource-id | R0 |
| `POST /api/rtc/webhook` | `apps/server/internal/rtc/rtc.go:102` | public | signed-SFU | RTC |
| `POST /api/sticker-packs/{id}/stickers` | `apps/server/internal/stickers/stickers.go:74` | allow | resource-id | R0 |
| `POST /api/tasks/{id}/approval` | `apps/server/internal/boards/boards.go:96` | deny | resource-id | R0 |
| `POST /api/tasks/{id}/archive` | `apps/server/internal/boards/boards.go:92` | allow | resource-id | R0 |
| `POST /api/tasks/{id}/restore` | `apps/server/internal/boards/boards.go:93` | allow | resource-id | R0 |
| `POST /api/workspaces` | `apps/server/internal/workspaces/workspaces.go:85` | deny | global-account | G0 |
| `POST /api/workspaces/{id}/apps` | `apps/server/internal/workspaces/apps.go:33` | deny | workspace-id | W0 |
| `POST /api/workspaces/{id}/backgrounds` | `apps/server/internal/workspaces/backgrounds.go:38` | deny | workspace-id | W0 |
| `POST /api/workspaces/{id}/badges` | `apps/server/internal/workspaces/badges.go:29` | allow | workspace-id | W0 |
| `POST /api/workspaces/{id}/bans` | `apps/server/internal/workspaces/bans.go:23` | allow | workspace-id | W0 |
| `POST /api/workspaces/{id}/boards` | `apps/server/internal/boards/boards.go:65` | allow | workspace-id | W0 |
| `POST /api/workspaces/{id}/bots` | `apps/server/internal/bots/bots.go:91` | deny | workspace-id | W0 |
| `POST /api/workspaces/{id}/bots/add` | `apps/server/internal/bots/bots.go:93` | deny | workspace-id | W0 |
| `POST /api/workspaces/{id}/bots/{botId}/avatar` | `apps/server/internal/bots/bots.go:97` | deny | workspace-id | W0 |
| `POST /api/workspaces/{id}/bots/{botId}/token` | `apps/server/internal/bots/bots.go:95` | deny | workspace-id | W0 |
| `POST /api/workspaces/{id}/categories` | `apps/server/internal/rooms/categories.go:21` | allow | workspace-id | W0 |
| `POST /api/workspaces/{id}/events` | `apps/server/internal/calendar/calendar.go:92` | allow | workspace-id | W0 |
| `POST /api/workspaces/{id}/files` | `apps/server/internal/files/files.go:136` | allow | workspace-id | W0 |
| `POST /api/workspaces/{id}/freebusy/suggest` | `apps/server/internal/calendar/calendar.go:99` | allow | workspace-id | W0 |
| `POST /api/workspaces/{id}/integrations/gptunnel` | `apps/server/internal/recording/recording.go:132` | deny | workspace-id | W0 |
| `POST /api/workspaces/{id}/invites` | `apps/server/internal/moderation/moderation.go:69` | allow | workspace-id | W0 |
| `POST /api/workspaces/{id}/invites/email` | `apps/server/internal/moderation/moderation.go:70` | allow | workspace-id | W0 |
| `POST /api/workspaces/{id}/invites/lookup` | `apps/server/internal/workspaces/email_invites.go:52` | deny | workspace-id | W0 |
| `POST /api/workspaces/{id}/join` | `apps/server/internal/moderation/moderation.go:72` | deny | workspace-id | W0 |
| `POST /api/workspaces/{id}/members` | `apps/server/internal/moderation/moderation.go:71` | deny | workspace-id | W0 |
| `POST /api/workspaces/{id}/members/{userId}/promote` | `apps/server/internal/workspaces/workspaces.go:100` | allow | workspace-id | W0 |
| `POST /api/workspaces/{id}/roles` | `apps/server/internal/workspaces/roles.go:31` | allow | workspace-id | W0 |
| `POST /api/workspaces/{id}/rooms` | `apps/server/internal/rooms/rooms.go:57` | allow | workspace-id | W0 |
| `POST /api/workspaces/{id}/rooms/temp` | `apps/server/internal/moderation/moderation.go:74` | allow | workspace-id | W0 |
| `POST /api/workspaces/{id}/sip/test` | `apps/server/internal/moderation/moderation.go:64` | deny | workspace-id | W0 |
| `POST /api/workspaces/{id}/sounds` | `apps/server/internal/moderation/moderation.go:54` | allow | workspace-id | W0 |
| `POST /api/workspaces/{id}/sticker-packs` | `apps/server/internal/moderation/moderation.go:52` | allow | workspace-id | W0 |
| `PUT /api/admin/users/{id}/storage-quota` | `apps/server/internal/plans/admin.go:52` | deny | global-admin | G0 |
| `PUT /api/admin/workspaces/{id}/plan` | `apps/server/internal/plans/admin.go:48` | deny | global-admin | G0 |
| `PUT /api/admin/workspaces/{id}/suspension` | `apps/server/internal/plans/admin.go:50` | deny | global-admin | G0 |
| `PUT /api/boards/{id}/permissions` | `apps/server/internal/boards/boards.go:72` | deny | resource-id | R0 |
| `PUT /api/boards/{id}/position` | `apps/server/internal/boards/boards.go:70` | allow | resource-id | R0 |
| `PUT /api/bots/me/commands` | `apps/server/internal/bots/bots.go:102` | allow | resource-id | R0 |
| `PUT /api/bots/me/webhook` | `apps/server/internal/bots/bots.go:104` | allow | resource-id | R0 |
| `PUT /api/events/{id}/rsvp` | `apps/server/internal/calendar/calendar.go:96` | deny | resource-id | R0 |
| `PUT /api/me/caldav` | `apps/server/internal/caldav/service.go:126` | deny | global-account | G0 |
| `PUT /api/me/sticker-packs/order` | `apps/server/internal/stickers/stickers.go:79` | allow | global-account | G0 |
| `PUT /api/me/sticker-packs/{id}` | `apps/server/internal/stickers/stickers.go:80` | allow | global-account | G0 |
| `PUT /api/messages/{id}/embeds-hidden` | `apps/server/internal/messages/messages.go:75` | allow | resource-id | R0 |
| `PUT /api/messages/{id}/pin` | `apps/server/internal/messages/messages.go:71` | allow | resource-id | R0 |
| `PUT /api/messages/{id}/reactions/{emoji}` | `apps/server/internal/messages/messages.go:69` | allow | resource-id | R0 |
| `PUT /api/rooms/{id}/notifications` | `apps/server/internal/rooms/rooms.go:64` | deny | resource-id | R0 |
| `PUT /api/rooms/{id}/permissions` | `apps/server/internal/rooms/rooms.go:63` | allow | resource-id | R0 |
| `PUT /api/rooms/{id}/read` | `apps/server/internal/messages/messages.go:66` | allow | resource-id | R0 |
| `PUT /api/sticker-packs/{id}/stickers/{sid}` | `apps/server/internal/stickers/stickers.go:75` | allow | resource-id | R0 |
| `PUT /api/tasks/{id}/approvers` | `apps/server/internal/boards/boards.go:95` | allow | resource-id | R0 |
| `PUT /api/tasks/{id}/assignees` | `apps/server/internal/boards/boards.go:94` | allow | resource-id | R0 |
| `PUT /api/tasks/{id}/read` | `apps/server/internal/boards/boards.go:100` | allow | resource-id | R0 |
| `PUT /api/tasks/{id}/relations` | `apps/server/internal/boards/boards.go:97` | allow | resource-id | R0 |
| `PUT /api/tasks/{id}/subscription` | `apps/server/internal/boards/boards.go:99` | allow | resource-id | R0 |
| `PUT /api/users/{id}/note` | `apps/server/internal/users/users.go:56` | deny | global-account | G0 |
| `PUT /api/workspace-apps/{appId}/position` | `apps/server/internal/workspaces/apps.go:36` | deny | resource-id | R0 |
| `PUT /api/workspaces/{id}/members/{userId}/badge` | `apps/server/internal/workspaces/badges.go:32` | allow | workspace-id | W0 |
| `PUT /api/workspaces/{id}/members/{userId}/roles` | `apps/server/internal/workspaces/roles.go:35` | allow | workspace-id | W0 |
| `PUT /api/workspaces/{id}/notifications` | `apps/server/internal/workspaces/workspaces.go:92` | deny | workspace-id | W0 |
| `PUT /api/workspaces/{id}/roles/order` | `apps/server/internal/workspaces/roles.go:32` | allow | workspace-id | W0 |
| `PUT /api/workspaces/{id}/rooms/order` | `apps/server/internal/rooms/categories.go:24` | allow | workspace-id | W0 |
| `PUT /api/workspaces/{id}/sip` | `apps/server/internal/sip/sip.go:125` | deny | workspace-id | W0 |
<!-- ROUTES-END -->

## Planned 2.0 endpoints (not registered at the audited baseline)

Source: frozen `release-2.0-identity.md` §§5–8 at `5f8b2caa`. These are **planned**, not part of
the 266 registered baseline patterns. Resource IDs below must still be loaded from trusted state;
standard provider endpoints do not go through first-party token fallback. The integration worker
must add their actual registration/policy call/test names after Foundation and consumers settle.
`I` is the trusted configured origin + `/oidc/workspaces/{workspace_uuid}`.

| Planned methods/path | Required policy/authority and proof |
|---|---|
| GET `/api/auth/sso/workspaces/{slug}` | Public minimal descriptor, no secret/user existence oracle; P0/A0, T03/T04. |
| POST `/api/auth/reauth` | Independent local bearer/password; G0; T02/T04. |
| GET `/api/workspaces/{id}/identity` | Member own status/lock/assurance; redacted owner-only configuration, scope A only; W0/A0/T01/T02. |
| PUT `/api/workspaces/{id}/identity/connection`; POST `/api/workspaces/{id}/identity/test` | Owner + local reauth; manage_sso/test bootstrap restrictions, config revision; W0/G0/T03/T04/T08. |
| PUT `/api/workspaces/{id}/identity/policy` | Owner, fresh local+SSO proofs or recovery-only repair; tested config/link/recovery kit before enforced; W0/C0/T06/T08. |
| POST `/api/auth/sso/workspaces/{id}/begin` | Saved purpose/login/step_up/link/test, trusted config; bootstrap_link for linking, no content access; T03/T04/T05. |
| GET `/api/auth/sso/browser-start`; GET `/api/auth/sso/callback/{connection_id}` | One-use browser binding/state/TTL/config versions, no arbitrary issuer/redirect; T03/T05/T14. |
| POST `/api/auth/sso/finish`; POST `/api/auth/sso/exchange` | Bound web cookie or initiating native verifier+ticket; atomic consume, repeated policy/member/directory/plan; G1/W0/T03/T05. |
| POST `/api/auth/sso/workspaces/{id}/refresh`; POST `/api/auth/sso/workspaces/{id}/logout` | Matching scoped cookie/row/workspace, immutable authority, no assurance extension; G1/T02/T07/T15. |
| DELETE `/api/workspaces/{id}/identity/link` | Own independent local reauth + fresh SSO, preserve recovery path; W0/G0/T04/T08. |
| POST `/api/workspaces/{id}/identity/recovery-kit` | Owner local reauth + fresh SSO, one-time kit, rotation revokes old; G0/W0/T08/T14. |
| POST `/api/auth/sso/workspaces/{id}/recover` | Existing owner independent local login + atomic recovery code; repair-only capability, no content/OAuth; G0/T08. |
| GET/PUT `/api/workspaces/{id}/identity/directory`; POST `.../directory/test`; POST `.../directory/sync`; GET `.../directory/members`; PUT `.../directory/members/{user_id}` | Owner + local reauth + required fresh SSO; manage_directory and entitlement, explicit objectGUID/member link, complete generation and 1h freshness; W0/T09/T14. |
| GET/POST `/api/workspaces/{id}/oauth/clients`; GET/PATCH/DELETE `/api/workspaces/{id}/oauth/clients/{client_id}`; POST `.../{client_id}/rotate-secret` | Builtin owner/admin + recent local reauth + required assurance, manage_oauth and entitlement; **custom MANAGE_INTEGRATIONS alone denied**; W0/G0/T01/T10/T13/T14. |
| GET `/api/me/oauth-grants`; DELETE `/api/me/oauth-grants/{id}` | Own grants filtered by session authority; revocation does not require paid entitlement, never revoke another user/workspace; A0/G1/T02/T13. |
| POST `/api/oauth/requests/{id}/bind`; POST `/api/oauth/requests/{id}/decision` | Saved request/client/workspace and browser cookie + bearer + Origin/CSRF, atomic allow/deny; scoped A only for A; W0/T10/T11. |
| GET `I/.well-known/openid-configuration`; GET `/.well-known/oauth-authorization-server/oidc/workspaces/{uuid}`; GET `I/jwks` | Trusted issuer configuration, public supported metadata/keys only; P0/T14/T16. |
| GET `I/authorize` | oauth_issue, live first-party session authority + entitlement + required assurance + client/consent, exact redirect and PKCE; W0/T10. |
| POST `I/token` | Client auth, atomic code consume/refresh rotation plus fresh DB session/authority/grant/assurance/plan decisions; T10/T11/T12. |
| GET/POST `I/userinfo` | Provider access Bearer only; fresh DB oauth_userinfo, minimal claims, no global roles/email inferred from upstream; T12/T13. |
| POST `I/revoke` | Correct client binding, unknown token 200, no cross-client revoke; T11/T13. |

Normative acceptance mapping: T01 -> W0/entitlement; T02 -> G0/G1/A0; T03–T05 -> RP owner
tests + bootstrap/public boundary; T06 -> W0/R0/F0/C0; T07 -> GW/RTC; T08 -> recovery-only and
sticky enforcement; T09 -> Directory worker plus W0/GW/RTC; T10–T14 -> provider/network/crypto owners
plus M0 token isolation; T15 -> baseline compatibility plus final PG17/18 schema/drift; T16 ->
independent RP and real Microsoft environments. This worker executed **baseline subsets of T15
only**, not complete T15 or any identity acceptance T01–T16.

## Completion boundary

Executed baseline and infrastructure checks are in [identity-v2-validation.md](identity-v2-validation.md).
The enforcement worker should attach a test name and final commit to every applicable proof ID/route
and channel above, enumerate new identity/OAuth routes after integration, and require zero unreviewed
patterns. Future full server integration, manual UI QA, independent security/protocol reviews and
real Entra/AD FS acceptance are not replaced by this audit or the local Keycloak smoke.
