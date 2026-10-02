# Identity 2.0 production operator preflight

Read-only inspection on 2026-10-01, context `gptunnel`, namespace `calab`.
Contract: [ADR-0054](../adr/0054-workspace-identity.md) and
[release specification](release-2.0-identity.md), inspected at
`601bfe984d4f44d2f8f53f69e7aee67fdb35e20f`. Infra evidence is the accepted
[deployment check](identity-v2-deployment-check.md) at `51bed095`, which the lead
confirmed merged into `1546d769`; its local checks are that worker's evidence,
not production acceptance here.

**Identity activation is blocked by configuration delivery and front-proxy logging.**
No cluster writes, restarts, production synthetic requests, key generation, real
request-log reads, Vault secret reads, or secret-value output occurred. This is
an operator preflight, not an independent security review; final QA/R1/R2 have
not started. Only this new document is changed.

## Observed deployment and ownership

| Object | Actual delivery/ownership evidence |
| --- | --- |
| `calab/api`, `calab/web` | Two ready replicas each; both annotated with deployment `6782937228`, SHA `99a60fc54cb1989c26c1a114a77631ea3380ecde`. API digest `sha256:537ed5e99430192e3054fcc48e6b3a21c15925a99e46a2648246f8736e909532`; web digest `sha256:bf49d18978e55ce8e76444b06bf95fd90d0f1e0e20f62220a3ec21e2c8f673e4`. |
| `calab/calab-env` Secret | 12 key names; no `IDENTITY_`/`OAUTH_SIGNING_` names. Desired data comes from Vault KV v2 `kv/data/app/calab` (logical path `kv/app/calab`), through `timenote/calab-env-sync`. |
| `timenote/calab-env-sync` CronJob | Every 10 minutes, unsuspended; last observed success `2026-10-01T15:40:09Z`. SA `calab-env-sync`, Vault role `env-ro-calab`, endpoint `https://vault.vault.svc:8200`, script `timenote/env-sync-script`, key `sync.py`, mounted `/app/sync.py`. |
| `calab/calab-api` ConfigMap | 18 key names, no identity/signing names. `kubectl-client-side-apply` owns `.data` (2026-10-01 06:34:34Z); no ownerReferences or GitOps provenance labels. API consumes this ConfigMap then `calab-env` via envFrom. No reconciler for this ConfigMap was identified. |
| `calab/calab-web-config` ConfigMap | Client-side-applied, no ownerReferences/provenance labels. Keys `Caddyfile`, `cluster-sites.sh`, `entrypoint.sh`; stock Caddy 2.11.4 image. Config is cluster-owned, HTTP `:8080`, upstream `api:3000`; repo host-network `caddy-l4` config cannot replace it verbatim. |
| `timenote/calab-deploy` CronJob | Every 3 minutes, unsuspended; last observed success `2026-10-01T15:42:08Z`. SA `calab-deploy`, script `timenote/calab-deploy-script`, key `calab-deploy.py`. Only changes image digests and deployment metadata; does not deliver API/web configuration. |
| `calab/calab` Ingress | Class `nginx`, all seven host rules target `web`. Client-side-applied spec; nginx manager owns status only. No access-log annotation. |
| `default/ingress-nginx-controller` | Helm release `ingress-nginx` in `default`, chart `ingress-nginx-4.13.0`, controller 1.13.0, Nginx 1.27.1. Uses `default/ingress-nginx-controller` ConfigMap, whose data is empty. No custom template volume observed. |

Live metadata identifies writers, not the checkout that supplied their manifests.
The deploy script specifically names **`calab/web/` in the platform infra source**
for Caddy updates, but neither that repository URL/revision nor exact manifest
filenames are exposed. The platform owner must identify those files and the
`calab-api`, ingress, and two CronJob manifest paths before a release can persist
changes there. Do not invent a Calab-repo manifest or claim an Argo/Flux owner.

The lead inspected platform candidate `/Users/macbook/Documents/Projects/cloud-infra`,
origin `git@github.com:script-heads/cloud-infra.git`, then fetched exact current remote
main `0a7510fa8056a9a678483c1e33a75f511cf53ed7` into separate bare
`/tmp/calab-platform-tree-pv6p8ifr` on 2026-10-01. The lead's `git ls-tree` evidence
contains zero Calab/env-sync filename paths at that revision. The original local
checkout (`3d7798578b794a5b6aeb8eace1f1daa0b78bdf70`, 2026-08-01) was untouched;
no unrelated file contents or secrets were inspected. This candidate has not
identified the actual platform manifest source: its checkout, revision and exact
paths are still required from the platform owner. This update records the lead's
evidence; the release-preparation worker did not repeat the fetch.

## Persistent key/config delivery

The actual `sync.py` reads the entire Vault map, stringifies each value, base64
encodes it for the Secret, and merge-patches desired keys **plus explicit nulls
for deleted keys**. `MIN_KEYS=12`, `MAX_DELETE=1`, `MAX_TARGETS=3`; no
`EXCLUDE_KEYS` override is configured. One manually added Secret-only key can
be deleted at the next sync; multiple missing keys stop reconciliation rather
than make them durable. Do not patch keyrings into the live Secret as their source.

It finds Deployment consumers of `calab-env` by envFrom and orders API first.
`env-sync/env-checksum` lives in **Deployment metadata**, not the pod template;
`env-sync/restartedAt` in the template triggers restart. The checksum is SHA-256
of sorted JSON of the desired base64 Secret data. It stamps the checksum only
after rollout readiness (240-second wait), retrying stale deployments on later
runs. Some rollout errors are logged without making the job exit nonzero:
CronJob success alone does not prove API delivery. Do not manually stamp it.

The minimum persistent delivery in an authorized release window is:

1. The Vault write-capable platform operator updates **one complete version of
   `kv/app/calab`**, preserving existing keys and storing
   `IDENTITY_ENCRYPTION_KEYS`, `IDENTITY_ENCRYPTION_ACTIVE_KID`,
   `OAUTH_SIGNING_KEYS`, `OAUTH_SIGNING_ACTIVE_KID` as strings. The CronJob uses
   `env-ro-calab` only for login/read; its actual Vault ACL was not inspected.
   Provisioning needs the platform's authorized writer. Keyring JSON must stay a JSON
   **string**, including escaped PEM newlines; a Vault nested object would become
   a Python dict string and fail the Go JSON loader. Use independent protected
   operator-provided keys, never `JWT_SECRET`; no keys were generated here.
2. Deliver `IDENTITY_PUBLIC_ORIGIN=https://app.calab.ru` as the lead-approved canonical
   origin in the platform source for `calab-api` (matches its current
   `PUBLIC_APP_URL`, confirmed by the lead on 2026-10-01).
   Put edition/workspace/network settings there when required by the pilot.
   Avoid duplicate names in Secret and ConfigMap: later envFrom sources win.
   ConfigMap-only edits do not alter the Secret checksum and therefore do not
   trigger this synchronizer; its platform workflow must explicitly roll API.
3. Stage during the **old, identity-unaware binary** period, or otherwise stop
   serving new pods until both ConfigMap and Secret are complete. A new binary
   with all seven dependency settings absent runs unconfigured (identity 503);
   a partially delivered origin/keyring/network policy fails startup. ConfigMap
   delivery and the 10-minute Secret sync are not an atomic transaction.
4. Observe the new Vault version/Secret resourceVersion, a full API rollout,
   matching `env-sync/env-checksum`, and both replicas' approved image digests.
   Verify key IDs/public JWKS later without printing private values. Protect a
   restorable Vault version with the DB backup. Vault writer identity, backup
   destination/restore procedure and actual private-key validity remain unknown
   because this task did not access Vault or secret values.

Signing rotation follows release §8: prepublish the next public key, roll all
replicas and wait at least 60 seconds before activating its private key; keep
the old public key for the last old ID token's lifetime (at most 5 minutes)
plus 60 seconds skew and 60 seconds JWKS cache. Keep encryption keys until all
dependent ciphertext is re-encrypted. A Secret/DB restore must retain those keys.

## Front ingress error logging remains exposed

The seven Calab vhosts are `app.calab.ru`, `app.calab.io`, `meet.gptunnel.ru`,
`calab.ru`, `calab.io`, `releases.calab.ru`, `releases.calab.io`. Locally filtered
`nginx -T` output showed no server/location error-log or access-log override
for them; they inherit HTTP directives:

```nginx
access_log /var/log/nginx/access.log upstreaminfo if=$loggable;
error_log /var/log/nginx/error.log notice;
```

The effective `upstreaminfo` format includes `$request` and `$http_referer`.
The [1.13.0 controller template](https://github.com/kubernetes/ingress-nginx/blob/controller-v1.13.0/rootfs/etc/nginx/template/nginx.tmpl)
implements the access annotation as location `access_log off`, independently
from HTTP `error_log`. The installed
[Nginx 1.27.1 error handler](https://github.com/nginx/nginx/blob/release-1.27.1/src/http/ngx_http_request.c#L3656)
adds request line and Referer to error context. Thus query/path handles and a
sensitive Referer can be emitted on upstream failures even with access logs off.
This is config/source evidence of exposure, not a claim to have read real logs
or reproduced a production failure. Changing Caddy cannot redact earlier ingress logs.

The supported minimum application-scoped access fix is this annotation in the
**platform source of `calab/calab`**, covering its seven host rules:

```yaml
nginx.ingress.kubernetes.io/enable-access-log: "false"
```

See the official [access-log annotation](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/#enable-access-log).
There is no documented per-Ingress error-log-disable annotation in this controller
version. `enable-rewrite-log: false` does not stop upstream errors; raising error
severity does not redact any records that remain. Shared-controller
`error-log-path`, `error-log-level`, global snippets and unrestricted snippet
annotations are outside this task's permitted solution.

**Concrete platform requirement:** the smallest vhost-scoped error fix is a
platform-owned [custom template](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/custom-template/)
based on the exact installed 1.13.0 template. Immediately inside each generated
server block, emit `error_log /dev/null;` only when `$server.Hostname` equals one
of the seven names above; leave other servers unchanged and keep annotation
snippets disabled. Confirm that generated child locations add no other error
sink. This loses Calab Nginx error diagnostics, keeps status/latency metrics,
requires an owner-maintained template on controller upgrades, and reloads the
shared controller despite the policy being scoped. It is a proposed platform
change, not an already installed or validated fix.

A vhost override alone is **not proven** to cover failures before virtual-server
selection or logging by controller/LB/collectors. If the platform cannot prove
those cases safe, provide a Calab-only ingress endpoint/controller instead:
proposed class `calab-identity`, controller class `calab.ru/identity-ingress-nginx`,
unique election ID, separate LoadBalancer, and only Calab ingress ownership.
Its own ConfigMap can set `disable-access-log: "true"`,
`error-log-path: /dev/null`, `enable-syslog: "false"`,
`allow-snippet-annotations: "false"`; inspect its rendered main/HTTP/default-server
configuration as well. These settings must never be applied to the current
shared ConfigMap. Migrate all seven host routes/DNS/TLS to the isolated endpoint
so requests do not first traverse the shared controller; preserving backend
timeouts/body limits and certificate management is part of that platform change.
This costs a separate controller/LB and removes its Nginx error diagnostics.
See official [multiple-controller isolation](https://kubernetes.github.io/ingress-nginx/user-guide/multiple-ingress/)
and [error-log-path](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/configmap/#error-log-path).
Neither option has been implemented or accepted here.

## Release and rollback gates specific to this deployment

- Port the infra worker's routing, sensitive-response/referrer policies, access
  discard and error-field deletion into `calab-web-config`, retaining HTTP :8080,
  `api:3000`, `cluster-sites.sh`, landing/release sites and existing aliases.
  Current config only proxies `/api/*`, `/gateway`, `/healthz`; provider paths
  fall through to SPA HTML. Validate the rendered config with stock Caddy 2.11.4.
- Update the platform manifest's `timenote/calab-deploy` `UPSTREAM_PINS` only
  after reviewing that port. Current pins: Caddyfile
  `c328e722a924cc689141f703c69554bb43f1b46690bec27257cc18e3ec6cbc36`,
  entrypoint `bea6ebef58b0c68580eba620f3324fd7323a127de332b9c4352795d085f81a7c`.
  These are hashes of **repo files**, not cluster-rendered files. At the release
  SHA compute those two repo hashes; do not substitute the live Caddyfile hash
  `9d881b72e32193d264374bcfe47ae5f52420df44aafe3d163d89ab2b9550e486`.
  The script checks pins **after** image rollout; drift exits 1 but leaves the
  new images running. A configuration-port omission is not an automatic rollback.
- [Images workflow](../../.github/workflows/images.yml) files `calab-prod` with
  api/web digests after green tag CI. Actual consumer checks bot creator, task,
  environment, payload digests and membership in main, then updates components
  sequentially. A component timeout returns that component's old image and
  records `calab-deploy/rejected-id`; an earlier successful component can remain
  on the new version. Rollback does not restore `calab-deploy/sha`, so inspect
  image digests rather than trusting that annotation. Treat mixed API/web
  revisions as failed acceptance.
- GitHub read-only GET confirmed deployment `6782937228` matches both live
  digests/SHA; its statuses list is empty. The consumer does not post GitHub
  statuses. Deployment creation and CronJob success are insufficient evidence;
  require Kubernetes annotations/readiness plus later API/web version smoke.
- `calab-api` has `MIGRATE_ON_START=true`; release migrations run under the
  application advisory lock. No production DB/migration state was inspected.
  Require final-SHA PG17 migration/compatibility evidence and a protected DB
  backup before the first image rollout. Identity migration 00055's Down guard
  blocks enforced policy/live scoped sessions, but **does not prevent an image-only
  rollback**. Do not rerun a pre-identity `images` workflow or accept automatic
  rollback to an identity-unaware digest after pilot activation. Provision an
  approved identity-aware fallback and corresponding configuration/pins first;
  retain encryption/verification keys. Start off, optional pilot, recovery
  acceptance, then enforced, as ADR-0054 requires.
- Before activation, an authorized operator must run synthetic code/state/ticket/
  request/consent/path/Referer sentinels through success, upstream failure,
  redirects and early parser errors on every app alias. Inspect only synthetic
  evidence across ingress/Caddy/API and upstream LB/log collectors. Record
  configuration revisions, public kids, release digests, flow/revoke/recovery
  results and absence of sentinels; no real credentials in reports. Collector/LB
  policies and actual production error output remain unverified here.

## Evidence limits

Inspection used scoped `kubectl get` metadata/managedFields/key-name projections,
the two relevant CronJob specs and mounted script ConfigMaps, and `nginx -v/-T`
through read-only exec. Nginx dumps stayed in process memory and only main/HTTP
logging directives, the shared log-format definition and Calab server/location
directives were printed; unrelated vhost content was not exposed. Successful
`nginx -T` exits were obtained on controller pods `2r7gm`, `8sqv2`, `fbkm6`
(prefix `ingress-nginx-controller-56bcfcc4fb-`). Pod `khcp7` returned nonzero even
with a test-success marker; its dump is not counted as successful validation.
No reload followed. GitHub inspection used only GET deployment/status endpoints;
the existing dotenv token was passed solely as child `GH_TOKEN`, never printed.

Unresolved release owners/actions are concrete: the platform manifest checkout
and revision, Vault writer/backup path and key provisioning, Calab ingress error
isolation and LB/collector acceptance, cluster Caddy port plus pin update,
identity-aware rollback digest, and final-SHA QA/two independent reviews.
