#!/usr/bin/env bash
# Release runbook as one command (docs/06, "Релиз: runbook"). Builds, deploys and verifies ONE commit.
#
#   infra/docker/release.sh <commit>                 # default: preflight web deploy verify desktop announce
#   infra/docker/release.sh verify <commit>          # post-checks only (against what is deployed now)
#   STEPS="deploy verify" infra/docker/release.sh <commit>   # a subset (order is always the canonical one)
#
# Env: VERSION (default 0.1.0) · STAND_HOST (root@141.105.69.177) · STAND_IP (141.105.69.177)
#      APP_HOST (app.calab.ru) · ALIAS_HOST (meet.gptunnel.ru) · LANDING_HOST (calab.ru, empty = none)
#      RELEASES_HOST (releases.calab.ru) · RTC_HOST (rtc.calab.ru) · WORK_DIR ($TMPDIR/calaba-release-$VERSION)
#      GH_TOKEN (default: GITHUB_TOKEN from the root .env; for gh only)
#      CALAB_RELEASE_BOT_TOKEN (default: from the root .env; announce only) · CALAB_API_URL (https://$APP_HOST)
#      CALAB_RELEASE_ROOM (default in tools/release-announce.py)
# Every HTTP check and the e2e go to STAND_IP directly (curl --resolve / forced browser DNS): local VPNs and
# not-yet-propagated names cannot fake a result.
#
# Desktop installers are NOT built or published from this Mac: the tag push in `desktop` triggers
# .github/workflows/release.yml (native runners, mac signed + notarized) → GitHub Release + S3 →
# https://$RELEASES_HOST/ (docs/06 «Релизы: GitHub Actions → S3»). The stand only redirects /download/ there.
#
# What it does:
#   preflight  commit resolves, tag v$VERSION absent (local + origin), release.yml in the commit, CHANGELOG
#              section for $VERSION (WARN only), gh auth,
#              lockfile frozen-installable, disk, stand reachable, baseline of the foreign GPU job, backup BEFORE
#   build      (optional, not in the default) local desktop build for checks: build-release.sh mac linux win
#              (SIGN=1 NOTARIZE=1, Linux/Windows on the stand's Docker) → $WORK_DIR/dist-release; never published
#   web        clean export of <commit> (git archive + frozen install) → `pnpm -F @calaba/desktop build:web`
#              → dist-web, and (LANDING_HOST set) `pnpm -F @calaba/landing build` → apps/landing/out
#   deploy     infra/docker/sync.sh with SYNC_REF=<commit>, VERSION: whole stack (api rebuilt with the build
#              info, unchanged services untouched), web static, landing (from the same export); SKIP_RELEASES
#   verify     smoke on both app hosts (/healthz, /api/version, TLS chain), landing, /download/ → 302 to
#              RELEASES_HOST (app, alias, landing; /download/win and /download/ by UA → latest/), REL/ →
#              the landing, /readyz inside; e2e:web on APP_HOST only, Chromium only (Firefox and the alias
#              are covered by nightly — CLAUDE.md) with a dedicated e2e account (its «Web …» workspaces are deleted afterwards) and the move scenario M.1 (a second e2e account;
#              when the commit has the spec); relay-check tls/udp/any with an API join token + a publisher,
#              api/LiveKit logs clean, foreign job intact, backup AFTER
#   desktop    only when nothing failed: git tag -a v$VERSION <commit>, push the tag to origin, wait for the
#              release.yml run of that tag (all jobs green), then the feed: latest*.yml on RELEASES_HOST,
#              every file in them 200 with the size from the yml, sha512 recomputed ON the stand, latest/VERSION
#              and the five latest/<stable name> files (stable versions only), the GitHub
#              Release published (not a draft)
#   announce   only when nothing failed and CALAB_RELEASE_BOT_TOKEN is set (else skipped): the bot posts the
#              CHANGELOG section of $VERSION (from <commit>) into the «what's new» room —
#              tools/release-announce.py; nonce release-$VERSION, so a re-run never double-posts. After
#              `desktop` on purpose: the post links the GitHub Release and promises the auto-update feed
#
# Nothing here prints secrets: credentials are read over ssh into variables and used directly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
if [[ "${1:-}" == verify ]]; then STEPS="verify"; shift; fi
COMMIT_REF="${1:?usage: release.sh [verify] <commit>}"
VERSION="${VERSION:-0.1.0}"
STEPS="${STEPS:-preflight web deploy verify desktop announce}"
HOST="${STAND_HOST:-root@141.105.69.177}"
IP="${STAND_IP:-141.105.69.177}"
D1="${APP_HOST:-app.calab.ru}"          # the app
D2="${ALIAS_HOST:-meet.gptunnel.ru}"  # an alias of the app (must behave the same)
LAND="${LANDING_HOST-calab.ru}"
RTC="${RTC_HOST:-rtc.calab.ru}"
REL="${RELEASES_HOST:-releases.calab.ru}"
REPO="${RELEASE_REPO:-itrcz/calab}"
if [[ -z "${GH_TOKEN:-}" && -f .env ]]; then   # gh only; never printed
  GH_TOKEN="$(sed -nE 's/^GITHUB_TOKEN=["'"'"']?([^"'"'"']*)["'"'"']?$/\1/p' .env | tail -1)"; export GH_TOKEN
fi
if [[ -z "${CALAB_RELEASE_BOT_TOKEN:-}" && -f .env ]]; then   # announce only; never printed
  CALAB_RELEASE_BOT_TOKEN="$(sed -nE 's/^CALAB_RELEASE_BOT_TOKEN=["'"'"']?([^"'"'"']*)["'"'"']?$/\1/p' .env | tail -1)"
fi
rcurl() { # curl pinned to the stand IP for the host of the first https:// argument
  local a h=""; for a in "$@"; do [[ "$a" == https://* ]] && { h="${a#https://}"; h="${h%%/*}"; break; }; done
  curl -sS --max-time 30 ${h:+--resolve "$h:443:$IP"} "$@"
}
WORK="${WORK_DIR:-${TMPDIR:-/tmp}/calaba-release-$VERSION}"
OUT="$WORK/dist-release"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20)
COMMIT="$(git rev-parse --short "$COMMIT_REF^{commit}")"
FAILS=0

step() { [[ " $STEPS " == *" $1 "* ]]; }
log() { printf '\n==> %s\n' "$*"; }
ok() { printf '  PASS  %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi; }
on_stand() { "${SSH[@]}" "$HOST" "$@"; }

foreign_state() { # the other tenant's job — must be identical before and after ([C]: pgrep -f must not match its own ssh shell)
  on_stand 'pgrep -f "[C]omfyUI/.venv" | sort | tr "\n" " "; echo; docker ps --format "{{.Names}} {{.CreatedAt}}" | grep -v "^calaba-" | sort'
}
backup() { on_stand 'systemctl start calaba-backup.service && journalctl -u calaba-backup.service -n 8 --no-pager -o cat | grep "calaba-backup: done"'; }

log "release v$VERSION from $COMMIT ($(git log -1 --format=%s "$COMMIT" | cut -c1-70)) — steps: $STEPS"

# --- preflight -------------------------------------------------------------------------------------
if step preflight; then
  log preflight
  if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then bad "tag v$VERSION already exists"; exit 1; fi
  if git ls-remote -q --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1; then bad "tag v$VERSION already exists on origin"; exit 1; fi
  ok "tag v$VERSION is free (local + origin)"
  git cat-file -e "$COMMIT:.github/workflows/release.yml" 2>/dev/null && ok "release.yml present in $COMMIT" || { bad "no .github/workflows/release.yml in $COMMIT"; exit 1; }
  # GitHub Release body = the CHANGELOG.md section of this version (release.yml); without one GitHub
  # auto-generates notes from commits — allowed, but user-facing notes are expected for every release
  chl="$(mktemp)"
  if git show "$COMMIT:CHANGELOG.md" > "$chl" 2>/dev/null && n=$(infra/ci/changelog-section.sh "$VERSION" "$chl" 2>/dev/null | wc -l | tr -d ' ') && (( n > 0 )); then
    ok "CHANGELOG.md in $COMMIT has a $VERSION section ($n lines) — used as the GitHub Release body"
  else
    printf '  WARN  %s\n' "CHANGELOG.md in $COMMIT has no $VERSION section — the GitHub Release gets auto-generated notes"
  fi
  rm -f "$chl"
  if step desktop; then
    gh api "repos/$REPO" --jq .full_name >/dev/null 2>&1 && ok "gh: access to $REPO" || { bad "gh: no access to $REPO (GH_TOKEN)"; exit 1; }
  fi
  tmp="$(mktemp -d)"; git archive "$COMMIT" package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc patches apps/*/package.json packages/*/package.json | tar -x -C "$tmp"
  if (cd "$tmp" && pnpm install --frozen-lockfile --lockfile-only --ignore-scripts >/dev/null 2>&1); then ok "lockfile in sync (frozen install)"; else rm -rf "$tmp"; bad "pnpm-lock.yaml out of sync with package.json in $COMMIT"; exit 1; fi
  rm -rf "$tmp"
  # the local desktop build (optional `build` step) needs ~15 GB; the default path (export, web, landing,
  # e2e) a couple of GB — desktop installers are built in GitHub Actions
  need_gb=5; step build && need_gb=15
  free_gb=$(df -g "${TMPDIR:-/tmp}" | awk 'NR==2{print $4}')
  (( free_gb >= need_gb )) && ok "local disk: ${free_gb} GB free (need ${need_gb})" || { bad "local disk: only ${free_gb} GB free (need ${need_gb})"; exit 1; }
  check "stand reachable" on_stand true
  mkdir -p "$(dirname "$WORK")"; foreign_state > "$WORK.foreign-before"
  ok "foreign job baseline: $(head -1 "$WORK.foreign-before")"
  backup >/dev/null && ok "backup BEFORE deploy" || { bad "backup before deploy failed"; exit 1; }
fi

# --- build (desktop, all OSes) ---------------------------------------------------------------------
if step build; then
  log "build desktop $VERSION ($COMMIT)"
  rm -rf "$OUT"
  SIGN="${SIGN-1}" NOTARIZE="${NOTARIZE-1}" VERSION="$VERSION" SRC_REF="$COMMIT" WORK_DIR="$WORK" OUT_DIR="$OUT" \
    BUILD_DOCKER_HOST="ssh://$HOST" apps/desktop/scripts/build-release.sh mac linux win
  ok "local desktop build in $OUT (checks only — the published installers come from release.yml)"
fi

# --- web + landing (clean export of the commit; reused from the build step when present) -----------
if step web; then
  log "build web client ($COMMIT)"
  if [[ ! -d "$WORK/src/node_modules" || "$(cat "$WORK/src/.release-commit" 2>/dev/null)" != "$COMMIT" ]]; then
    rm -rf "$WORK/src"; mkdir -p "$WORK/src"
    git archive "$COMMIT" | tar -x -C "$WORK/src"
    (cd "$WORK/src" && pnpm install --frozen-lockfile)
    echo "$COMMIT" > "$WORK/src/.release-commit"
  fi
  (cd "$WORK/src" && pnpm -F @calaba/desktop build:web)
  [[ -f "$WORK/src/apps/desktop/dist-web/index.html" ]] && ok "dist-web built" || { bad "dist-web missing"; exit 1; }
  if [[ -n "$LAND" ]]; then
    log "build landing ($COMMIT)"
    (cd "$WORK/src" && pnpm -F @calaba/landing build)
    [[ -f "$WORK/src/apps/landing/out/index.html" ]] && ok "landing built (static export)" || { bad "landing out/ missing"; exit 1; }
  fi
fi

# --- deploy ----------------------------------------------------------------------------------------
if step deploy; then
  log "deploy $COMMIT to $HOST"
  [[ -f "$WORK/src/apps/desktop/dist-web/index.html" ]] || { bad "no web build in $WORK/src (run the web step first)"; exit 1; }
  # landing only from this commit's export: never a stale local apps/landing/out
  landing_env=(SKIP_LANDING=1)
  [[ -n "$LAND" ]] && { [[ -f "$WORK/src/apps/landing/out/index.html" ]] || { bad "no landing build in $WORK/src (run the web step first)"; exit 1; }; landing_env=(LANDING_DIST="$WORK/src/apps/landing/out"); }
  env SYNC_REF="$COMMIT" VERSION="$VERSION" WEB_DIST="$WORK/src/apps/desktop/dist-web" SKIP_RELEASES=1 "${landing_env[@]}" \
    infra/docker/sync.sh
fi

# --- verify ----------------------------------------------------------------------------------------
if step verify; then
  log "verify v$VERSION ($COMMIT)"
  SRC_DIR="$WORK/src"
  if [[ ! -d "$SRC_DIR/node_modules" || "$(cat "$SRC_DIR/.release-commit" 2>/dev/null)" != "$COMMIT" ]]; then
    bad "no export of $COMMIT in $SRC_DIR (run the web step first)"; exit 1
  fi
  sleep 10
  # 1. health + build info on both domains (.ai via IP), readiness inside
  for d in "$D1" "$D2"; do
    code=$(rcurl -o /dev/null -w '%{http_code}' "https://$d/healthz" || echo 000)
    [[ "$code" == 200 ]] && ok "$d/healthz 200" || bad "$d/healthz $code"
    ver=$(rcurl "https://$d/api/version" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.version+"/"+j.commit)})' 2>/dev/null || echo "?")
    [[ "$ver" == "$VERSION/$COMMIT" ]] && ok "$d/api/version = $ver" || bad "$d/api/version = $ver (want $VERSION/$COMMIT)"
    # TLS: curl verifies chain + hostname (ssl_verify_result 0); openssl only reads the expiry (LibreSSL-safe)
    v=$(rcurl -o /dev/null -w '%{ssl_verify_result}' "https://$d/healthz" 2>/dev/null || echo fail)
    exp=$(openssl s_client -connect "$IP:443" -servername "$d" </dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    [[ "$v" == 0 && -n "$exp" ]] && ok "$d TLS: valid for the name, expires $exp" || bad "$d TLS: verify=$v expiry=${exp:-?}"
  done
  if [[ -n "$LAND" ]]; then
    code=$(rcurl -o /dev/null -w '%{http_code}' "https://$LAND/"); [[ "$code" == 200 ]] && ok "landing https://$LAND/ 200" || bad "landing $LAND → $code"
  fi
  code=$(rcurl -o /dev/null -w '%{http_code}' "https://$RTC/"); [[ "$code" == 200 ]] && ok "$RTC/ 200 (LiveKit)" || bad "$RTC/ → $code"
  r=$(on_stand 'curl -s 127.0.0.1:3000/readyz'); [[ "$r" == *'"postgres":"ok"'*'"redis":"ok"'* ]] && ok "readyz (inside): $r" || bad "readyz: $r"

  # 2. /download/ on the app and the landing: 302 to the release host, same path (electron-updater of
  #    older builds follows it); the feed itself is checked in the desktop step
  for d in "$D1" "$D2" ${LAND:+"$LAND"}; do
    r=$(rcurl -o /dev/null -w '%{http_code} %{redirect_url}' "https://$d/download/latest.yml" || echo 000)
    [[ "$r" == "302 https://$REL/latest.yml" ]] && ok "$d/download/ → https://$REL/" || bad "$d/download/latest.yml → '$r' (want 302 https://$REL/latest.yml)"
    # stable shortcuts → latest/<file>; bare /download/ picks the file by User-Agent
    r=$(rcurl -o /dev/null -w '%{http_code} %{redirect_url}' "https://$d/download/win" || echo 000)
    [[ "$r" == "302 https://$REL/latest/Calab-win-x64.exe" ]] && ok "$d/download/win → latest/" || bad "$d/download/win → '$r'"
    r=$(rcurl -o /dev/null -w '%{http_code} %{redirect_url}' -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' "https://$d/download/" || echo 000)
    [[ "$r" == "302 https://$REL/latest/Calab-mac-arm64.dmg" ]] && ok "$d/download/ (Mac UA) → latest/Calab-mac-arm64.dmg" || bad "$d/download/ (Mac UA) → '$r'"
  done
  if [[ -n "$LAND" ]]; then   # the release host's root is no bare listing: → the landing's download section
    r=$(rcurl -o /dev/null -w '%{http_code} %{redirect_url}' "https://$REL/" || echo 000)
    [[ "$r" == "302 https://$LAND/#download" ]] && ok "$REL/ → https://$LAND/#download" || bad "$REL/ → '$r' (want 302 https://$LAND/#download)"
  fi

  # credentials for the checks (over ssh, never printed)
  acc="$(on_stand 'cat /opt/calaba/infra/docker/.env.accounts')"
  OWNER_PW="$(awk '/^owner@/{print $2}' <<<"$acc")"; INVITE="$(awk '/^invite /{print $2}' <<<"$acc")"
  api() { rcurl "$@"; }
  login() { api -X POST "https://$D1/api/auth/login" -d "{\"email\":\"$1\",\"password\":\"$2\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).tokens.accessToken||"")}catch{console.log("")}})'; }

  # e2e account: password from .env.accounts, or registered once with the owner's invite (password goes
  # only to .env.accounts on the stand); prints the password, empty on failure (runs in $(…): the caller
  # records the FAIL, a `bad` in here would be lost with the subshell)
  ensure_account() { # email display-name
    local email="$1" name="$2" pw code
    pw="$(awk -v e="$email" '$1==e{print $2}' <<<"$acc")"
    if [[ -z "$pw" ]]; then
      pw="$(openssl rand -hex 12)"
      code=$(api -o /dev/null -w '%{http_code}' -X POST "https://$D1/api/auth/register" \
        -d "{\"email\":\"$email\",\"password\":\"$pw\",\"displayName\":\"$name\",\"inviteCode\":\"$INVITE\"}")
      [[ "$code" == 20? ]] || { echo "        registration of $email → HTTP $code" >&2; return 0; }
      printf '%s %s\n' "$email" "$pw" | on_stand 'umask 077; cat >> /opt/calaba/infra/docker/.env.accounts'
      ok "created e2e account $email (password stored in .env.accounts on the stand)" >&2
    fi
    printf '%s' "$pw"
  }

  # 3. e2e:web on APP_HOST, Chromium only (release gate; Firefox and the alias run nightly). Dedicated account
  #    (workspace creation is rate-limited per user), created once with the owner's invite; the «Web …»
  #    workspaces the spec creates are deleted afterwards. Specs + config come from the release commit's
  #    export (web step), never from the working tree, through the IP-forcing config (no local DNS/VPN).
  #    M.1 (move a participant between voice rooms, ADR-0019): A = the e2e account (admin of its «E2E web»),
  #    B = e2e-app2@; the spec is idempotent (reuses the workspace, rooms and invite) — no creation limit.
  #    Only the specs written for a real server: the others (e.g. notifications.web) target the mock
  #    (e2e-support) with its fixed accounts; move.web runs separately below with the second account.
  STAND_SPECS=(app.web link.web)
  d="$D1"; email="e2e-app@calaba.test"; cfg=../../infra/docker/tools/playwright.stand.config.ts
  pw="$(ensure_account "$email" "E2E app")"
  if [[ -z "$pw" ]]; then
    bad "e2e:web $d — no account $email"
  else
    if (cd "$SRC_DIR/apps/desktop" && CALABA_FORCE_IP="$IP" CALABA_WEB_URL="https://$d" CALABA_WEB_LOGIN="$email" \
          CALABA_WEB_PASSWORD="$pw" pnpm exec playwright test --config "$cfg" --project=chromium "${STAND_SPECS[@]}" >"$WORK.e2e-app.log" 2>&1); then
      ok "e2e:web $d (chromium, voice) — $(grep -oE '[0-9]+ passed' "$WORK.e2e-app.log" | tail -1)"
    else
      bad "e2e:web $d — see $WORK.e2e-app.log"
    fi
    if [[ -f "$SRC_DIR/apps/desktop/e2e-web/move.web.spec.ts" ]]; then
      email2="e2e-app2@calaba.test"; pw2="$(ensure_account "$email2" "E2E app 2")"
      if [[ -z "$pw2" ]]; then
        bad "e2e:web move (M.1) $d — no account $email2"
      elif (cd "$SRC_DIR/apps/desktop" && CALABA_FORCE_IP="$IP" CALABA_WEB_URL="https://$d" \
            CALABA_WEB_LOGIN="$email" CALABA_WEB_PASSWORD="$pw" CALABA_WEB_LOGIN2="$email2" CALABA_WEB_PASSWORD2="$pw2" \
            pnpm exec playwright test --config "$cfg" move --project=chromium >"$WORK.e2e-move.log" 2>&1); then
        ok "e2e:web move (M.1) $d, chromium — $(grep -oE '[0-9]+ passed' "$WORK.e2e-move.log" | tail -1)"
      else
        bad "e2e:web move (M.1) $d — see $WORK.e2e-move.log"
      fi
    else
      printf '  SKIP  %s\n' "e2e:web move (M.1): no e2e-web/move.web.spec.ts in $COMMIT"
    fi
    # cleanup: delete the workspaces the spec created (named "Web <browser>-<id>")
    t="$(login "$email" "$pw")"
    if [[ -n "$t" ]]; then
      ids=$(api "https://$D1/api/workspaces" -H "Authorization: Bearer $t" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const w of JSON.parse(s).workspaces||[]) if(/^Web /.test(w.name)) console.log(w.id)})')
      for id in $ids; do api -o /dev/null -X DELETE "https://$D1/api/workspaces/$id" -H "Authorization: Bearer $t"; done
      ok "cleanup: deleted $(echo $ids | wc -w | tr -d ' ') e2e workspace(s) of $email"
    fi
  fi

  # 4. voice: API join token (owner, room "voice" in workspace "team") + a publisher in that LiveKit room
  OT="$(login owner@calaba.test "$OWNER_PW")"
  ws=$(api "https://$D1/api/workspaces" -H "Authorization: Bearer $OT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const w=(JSON.parse(s).workspaces||[]).find(w=>w.slug==="team");console.log(w?w.id:"")})')
  voi=$(api "https://$D1/api/workspaces/$ws/rooms" -H "Authorization: Bearer $OT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=(JSON.parse(s).rooms||[]).find(r=>r.name==="voice");console.log(r?r.id:"")})')
  tok=$(api -X POST "https://$D1/api/rooms/$voi/join" -H "Authorization: Bearer $OT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).token||"")})')
  if [[ -n "$tok" ]]; then
    eval "$(on_stand 'grep -E "^LIVEKIT_API_(KEY|SECRET)=" /opt/calaba/infra/docker/.env' | sed 's/^/export /')"
    LIVEKIT_URL="wss://$RTC" lk load-test --room "ws_${ws}_room_${voi}" --audio-publishers 1 --video-publishers 1 \
      --subscribers 0 --duration 4m >"$WORK.publisher.log" 2>&1 & pub=$!
    sleep 8
    if node "$SRC_DIR/infra/docker/tools/relay-check.mjs" "wss://$RTC" "$tok" tls,udp,any | tee "$WORK.relay.log" | sed 's/^/        /'; then
      ok "relay-check tls/udp/any with media"
    else bad "relay-check (see $WORK.relay.log)"; fi
    kill "$pub" 2>/dev/null || true
    unset LIVEKIT_API_KEY LIVEKIT_API_SECRET
  else
    bad "voice: no join token (owner login / team / voice room)"
  fi

  # 5. logs clean, foreign job intact, backup after
  e=$(on_stand 'cd /opt/calaba/infra/docker && docker compose logs --since 15m api 2>&1 | grep -c "\"level\":\"ERROR\"" || true')
  [[ "$e" == 0 ]] && ok "api: no ERROR in 15 min" || bad "api: $e ERROR lines in 15 min"
  w=$(on_stand 'cd /opt/calaba/infra/docker && docker compose logs --since 15m livekit 2>&1 | grep -c "failed to send webhook" || true')
  [[ "$w" == 0 ]] && ok "livekit: webhooks delivered" || bad "livekit: $w failed webhooks"
  after="$(foreign_state)"
  if [[ -f "$WORK.foreign-before" ]]; then
    [[ "$after" == "$(cat "$WORK.foreign-before")" ]] && ok "foreign GPU job unchanged ($(head -1 <<<"$after"))" || bad "foreign job changed: $(tr '\n' '|' <<<"$after")"
  else
    [[ -n "$(head -1 <<<"$after" | tr -d ' ')" ]] && ok "foreign GPU job running ($(head -1 <<<"$after"))" || bad "foreign GPU job not found"
  fi
  backup >/dev/null && ok "backup AFTER deploy" || bad "backup after deploy failed"
  on_stand 'docker stats --no-stream --format "{{.Name}} {{.CPUPerc}} {{.MemUsage}}" | grep calaba' | sed 's/^/        /'
fi

# --- desktop: tag → release.yml (GitHub Actions) → S3 → RELEASES_HOST -------------------------------
if step desktop; then
  log "desktop v$VERSION via GitHub Actions ($REPO)"
  if (( FAILS )); then
    log "NOT tagging: $FAILS check(s) failed"
  else
    git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null || git tag -a "v$VERSION" "$COMMIT" -m "Calab $VERSION"
    [[ "$(git rev-parse --short "v$VERSION^{commit}")" == "$COMMIT" ]] || { bad "local tag v$VERSION does not point at $COMMIT"; exit 1; }
    git push origin "refs/tags/v$VERSION" && ok "pushed tag v$VERSION → $COMMIT"
    run=""
    for _ in $(seq 1 30); do   # the tag-push run shows up within seconds; give it 5 min
      run=$(gh run list --repo "$REPO" --workflow release.yml --event push --branch "v$VERSION" --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)
      [[ -n "$run" ]] && break; sleep 10
    done
    if [[ -z "$run" ]]; then
      bad "no release.yml run for tag v$VERSION"
    else
      # Poll instead of `gh run watch`: one API hiccup (TLS handshake timeout through a VPN) made
      # `watch` exit non-zero while the run was still going (0.7.0). Up to 10 failed polls in a row
      # are tolerated; the run itself has no time limit here (mac notarization takes ~40–60 min).
      st="" errs=0
      while :; do
        if st=$(gh run view "$run" --repo "$REPO" --json status,conclusion --jq '.status + " " + .conclusion' 2>>"$WORK.actions.log"); then
          errs=0; [[ "$st" == completed* ]] && break
        else
          errs=$((errs + 1)); (( errs >= 10 )) && { st="unknown (10 failed polls)"; break; }
        fi
        sleep 60
      done
      if [[ "$st" == "completed success" ]]; then
        ok "release.yml run $run: all jobs green"
      else
        bad "release.yml run $run: $st — $(gh run view "$run" --repo "$REPO" --json jobs --jq '[.jobs[]|select(.conclusion!="success" and .conclusion!="skipped")|.name]|join(", ")' 2>/dev/null)"
      fi
    fi
    # the feed on the release host (through the stand IP: Caddy → S3)
    files=""
    for y in latest-mac.yml latest-linux.yml latest.yml; do
      if body=$(rcurl -f "https://$REL/$y"); then
        grep -q "^version: $VERSION$" <<<"$body" && ok "$REL/$y: version $VERSION" || bad "$REL/$y: not version $VERSION"
        files+=$(awk '/^ *- url: /{u=$3} /^ *size: /{if(u!=""){print u" "$2; u=""}}' <<<"$body")$'\n'
      else bad "$REL/$y missing"; fi
    done
    n=0
    while read -r u size; do
      [[ -n "$u" ]] || continue; n=$((n + 1))
      got=$(rcurl -I "https://$REL/$u" | tr -d '\r' | awk 'tolower($1)=="content-length:"{l=$2} /^HTTP/{c=$2} END{print c" "l}')
      [[ "$got" == "200 $size" ]] && ok "$REL/$u (200, $size B)" || bad "$REL/$u → '$got' (want 200 $size)"
    done <<<"$files"
    (( n >= 5 )) && ok "feeds list $n files (mac arm64+x64 zip/dmg, AppImage, deb, exe)" || bad "feeds list only $n files"
    # latest/ (stable releases only): VERSION and the five stable names the landing links to
    if [[ "$VERSION" != *-* ]]; then
      lv=$(rcurl -f "https://$REL/latest/VERSION" 2>/dev/null | tr -d '[:space:]' || true)
      [[ "$lv" == "$VERSION" ]] && ok "$REL/latest/VERSION = $lv" || bad "$REL/latest/VERSION = '${lv:-missing}' (want $VERSION)"
      for f in Calab-mac-arm64.dmg Calab-mac-x64.dmg Calab-win-x64.exe Calab-linux-x86_64.AppImage calab-linux-amd64.deb; do
        c=$(rcurl -o /dev/null -I -w '%{http_code}' "https://$REL/latest/$f" || echo 000)
        [[ "$c" == 200 ]] && ok "$REL/latest/$f 200" || bad "$REL/latest/$f → $c"
      done
    fi
    sha=$(on_stand "python3 - https://$REL" <<'PY'
import base64, hashlib, re, sys, urllib.request
base = sys.argv[1]; bad = n = 0
for yml in ("latest-mac.yml", "latest-linux.yml", "latest.yml"):
    text = urllib.request.urlopen(f"{base}/{yml}", timeout=60).read().decode()
    for url, digest in re.findall(r"- url: (\S+)\n\s+sha512: (\S+)", text):
        n += 1; h = hashlib.sha512()
        with urllib.request.urlopen(f"{base}/{url}", timeout=600) as r:
            for chunk in iter(lambda: r.read(1 << 20), b""): h.update(chunk)
        if base64.b64encode(h.digest()).decode() != digest: bad += 1; print("MISMATCH", url)
print(f"{n} files checked, {bad} mismatches")
sys.exit(1 if bad or n == 0 else 0)
PY
) && ok "sha512 in latest*.yml match the files served by $REL ($sha)" || bad "sha512 check: $sha"
    # release.yml leaves the GitHub Release as a draft (the Actions token may not publish it — see the
    # github-release job): publish it with the owner's token once the feed checks above passed; with no
    # draft at all (the job failed), create it from the run's artifacts. Body = CHANGELOG section.
    if (( FAILS == 0 )); then
      st=$(gh release view "v$VERSION" --repo "$REPO" --json isDraft --jq .isDraft 2>/dev/null || echo absent)
      notes="$WORK.release-notes.md"
      git show "$COMMIT:CHANGELOG.md" > "$WORK.CHANGELOG.md" 2>/dev/null || : > "$WORK.CHANGELOG.md"
      body=(--generate-notes)
      if section=$(bash infra/ci/changelog-section.sh "$VERSION" "$WORK.CHANGELOG.md" 2>/dev/null) && [[ -n "$section" ]]; then
        printf '%s\n\n---\n%s\n' "$section" "**Скачать:** [calab.ru](https://calab.ru/#download) · файлы и обновления: [releases.calab.ru](https://releases.calab.ru/) · [все изменения](https://github.com/$REPO/blob/main/CHANGELOG.md)" > "$notes"
        body=(--notes-file "$notes")
      fi
      pre=(); [[ "$VERSION" == *-* ]] && pre=(--prerelease) || pre=(--latest)
      if [[ "$st" == true ]]; then
        edit_body=(); [[ "${body[0]}" == --notes-file ]] && edit_body=("${body[@]}")   # edit cannot regenerate notes
        gh release edit "v$VERSION" --repo "$REPO" --draft=false "${pre[@]}" "${edit_body[@]}" >/dev/null \
          && ok "GitHub Release v$VERSION published (was a draft)" || bad "publishing the draft v$VERSION failed"
      elif [[ "$st" == absent && -n "$run" ]]; then
        rm -rf "$WORK.assets"; mkdir -p "$WORK.assets"
        if gh run download "$run" --repo "$REPO" --pattern 'release-*' --dir "$WORK.assets" >/dev/null 2>&1; then
          assets=(); while IFS= read -r f; do assets+=("$f"); done < <(find "$WORK.assets" -type f)
          gh release create "v$VERSION" --repo "$REPO" --verify-tag "${pre[@]}" --title "Calab $VERSION" \
            "${body[@]}" "${assets[@]}" >/dev/null \
            && ok "GitHub Release v$VERSION created from the run's artifacts" || bad "creating GitHub Release v$VERSION failed"
        else bad "cannot download the artifacts of run $run"; fi
      fi
    fi
    rel=$(gh release view "v$VERSION" --repo "$REPO" --json isDraft,isPrerelease,assets --jq '"draft=\(.isDraft) prerelease=\(.isPrerelease) assets=\(.assets|length)"' 2>/dev/null || echo "absent")
    [[ "$rel" == draft=false* ]] && ok "GitHub Release v$VERSION: $rel" || bad "GitHub Release v$VERSION: $rel"
  fi
fi

# --- announce: the release notes into the «what's new» room (a bot, docs/19) --------------------------
if step announce; then
  log "announce v$VERSION"
  if [[ -z "${CALAB_RELEASE_BOT_TOKEN:-}" ]]; then
    echo "announce: skipped, no CALAB_RELEASE_BOT_TOKEN"
  elif (( FAILS )); then
    log "NOT announcing: $FAILS check(s) failed"
  else
    mkdir -p "$(dirname "$WORK")"
    git show "$COMMIT:CHANGELOG.md" > "$WORK.announce-CHANGELOG.md" 2>/dev/null || : > "$WORK.announce-CHANGELOG.md"
    if out=$(CALAB_RELEASE_BOT_TOKEN="$CALAB_RELEASE_BOT_TOKEN" CALAB_API_URL="${CALAB_API_URL:-https://$D1}" \
          python3 tools/release-announce.py "$VERSION" --changelog "$WORK.announce-CHANGELOG.md" 2>&1); then
      ok "$out"
    else
      bad "announce: $out"
    fi
  fi
fi

log "done: $FAILS failed check(s)"
exit $(( FAILS > 0 ))
