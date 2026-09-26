#!/usr/bin/env bash
# Release runbook as one command (docs/06, "Релиз: runbook"). Builds, deploys and verifies ONE commit.
#
#   infra/docker/release.sh <commit>                 # all steps: preflight build web deploy verify tag
#   infra/docker/release.sh verify <commit>          # post-checks only (against what is deployed now)
#   STEPS="deploy verify" infra/docker/release.sh <commit>   # a subset (order is always the canonical one)
#
# Env: VERSION (default 0.1.0) · STAND_HOST (root@141.105.69.177) · STAND_IP (141.105.69.177)
#      APP_HOST (app.calab.ru) · ALIAS_HOST (meet.gptunnel.ru) · LANDING_HOST (calab.ru, empty = none)
#      RTC_HOST (rtc.calab.ru) · WORK_DIR ($TMPDIR/calaba-release-$VERSION)
# Every HTTP check and the e2e go to STAND_IP directly (curl --resolve / forced browser DNS): local VPNs and
# not-yet-propagated names cannot fake a result.
#
# What it does:
#   preflight  commit resolves, tag v$VERSION absent, lockfile frozen-installable, disk, stand reachable,
#              baseline of the foreign GPU job, backup BEFORE
#   build      apps/desktop/scripts/build-release.sh mac linux win (VERSION, SRC_REF=<commit>; Linux/Windows
#              on the stand's Docker with limits) → $WORK_DIR/dist-release
#   web        `pnpm -F @calaba/desktop build:web` inside the same clean export → $WORK_DIR/src/apps/desktop/dist-web
#   deploy     infra/docker/sync.sh with SYNC_REF=<commit>, VERSION: whole stack (api rebuilt with the
#              build info, unchanged services untouched), web static, releases → /download/ (no --delete)
#   verify     /healthz + /api/version on both domains, /readyz inside, every artifact on /download/
#              (HTTP 200 + size) and sha512 of latest*.yml recomputed ON the stand, e2e:web on .ai (via IP)
#              and .ru with dedicated e2e accounts (their workspaces are deleted afterwards), relay-check
#              tls/udp/any with an API join token + a publisher, api/LiveKit logs clean, foreign job intact,
#              backup AFTER
#   tag        git tag -a v$VERSION <commit> (local only, never pushed)
#
# Nothing here prints secrets: credentials are read over ssh into variables and used directly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
if [[ "${1:-}" == verify ]]; then STEPS="verify"; shift; fi
COMMIT_REF="${1:?usage: release.sh [verify] <commit>}"
VERSION="${VERSION:-0.1.0}"
STEPS="${STEPS:-preflight build web deploy verify tag}"
HOST="${STAND_HOST:-root@141.105.69.177}"
IP="${STAND_IP:-141.105.69.177}"
D1="${APP_HOST:-app.calab.ru}"          # the app
D2="${ALIAS_HOST:-meet.gptunnel.ru}"  # an alias of the app (must behave the same)
LAND="${LANDING_HOST-calab.ru}"
RTC="${RTC_HOST:-rtc.calab.ru}"
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

foreign_state() { # the other tenant's job — must be identical before and after
  on_stand 'pgrep -f "ComfyUI/.venv" | sort | tr "\n" " "; echo; docker ps --format "{{.Names}} {{.CreatedAt}}" | grep -v "^calaba-" | sort'
}
backup() { on_stand 'systemctl start calaba-backup.service && journalctl -u calaba-backup.service -n 8 --no-pager -o cat | grep "calaba-backup: done"'; }

log "release v$VERSION from $COMMIT ($(git log -1 --format=%s "$COMMIT" | cut -c1-70)) — steps: $STEPS"

# --- preflight -------------------------------------------------------------------------------------
if step preflight; then
  log preflight
  if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then bad "tag v$VERSION already exists"; exit 1; fi
  ok "tag v$VERSION is free"
  tmp="$(mktemp -d)"; git archive "$COMMIT" package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc patches apps/*/package.json packages/*/package.json | tar -x -C "$tmp"
  if (cd "$tmp" && pnpm install --frozen-lockfile --lockfile-only --ignore-scripts >/dev/null 2>&1); then ok "lockfile in sync (frozen install)"; else rm -rf "$tmp"; bad "pnpm-lock.yaml out of sync with package.json in $COMMIT"; exit 1; fi
  rm -rf "$tmp"
  free_gb=$(df -g "${TMPDIR:-/tmp}" | awk 'NR==2{print $4}')
  (( free_gb >= 15 )) && ok "local disk: ${free_gb} GB free" || { bad "local disk: only ${free_gb} GB free (need 15)"; exit 1; }
  check "stand reachable" on_stand true
  mkdir -p "$(dirname "$WORK")"; foreign_state > "$WORK.foreign-before"
  ok "foreign job baseline: $(head -1 "$WORK.foreign-before")"
  backup >/dev/null && ok "backup BEFORE deploy" || { bad "backup before deploy failed"; exit 1; }
fi

# --- build (desktop, all OSes) ---------------------------------------------------------------------
if step build; then
  log "build desktop $VERSION ($COMMIT)"
  rm -rf "$OUT"
  VERSION="$VERSION" SRC_REF="$COMMIT" WORK_DIR="$WORK" OUT_DIR="$OUT" BUILD_DOCKER_HOST="ssh://$HOST" \
    apps/desktop/scripts/build-release.sh mac linux win
fi

# --- web (same clean export; node_modules from the macOS build) -----------------------------------
if step web; then
  log "build web client ($COMMIT)"
  [[ -d "$WORK/src/node_modules" ]] || { bad "no build export in $WORK/src (run the build step first)"; exit 1; }
  (cd "$WORK/src" && pnpm -F @calaba/desktop build:web)
  [[ -f "$WORK/src/apps/desktop/dist-web/index.html" ]] && ok "dist-web built" || { bad "dist-web missing"; exit 1; }
fi

# --- deploy ----------------------------------------------------------------------------------------
if step deploy; then
  log "deploy $COMMIT to $HOST"
  [[ -f "$OUT/latest.yml" && -f "$OUT/latest-mac.yml" && -f "$OUT/latest-linux.yml" ]] || { bad "incomplete $OUT"; exit 1; }
  SYNC_REF="$COMMIT" VERSION="$VERSION" WEB_DIST="$WORK/src/apps/desktop/dist-web" RELEASE_DIST="$OUT" \
    infra/docker/sync.sh
fi

# --- verify ----------------------------------------------------------------------------------------
if step verify; then
  log "verify v$VERSION ($COMMIT)"
  sleep 10
  # 1. health + build info on both domains (.ai via IP), readiness inside
  for d in "$D1" "$D2"; do
    code=$(rcurl -o /dev/null -w '%{http_code}' "https://$d/healthz" || echo 000)
    [[ "$code" == 200 ]] && ok "$d/healthz 200" || bad "$d/healthz $code"
    ver=$(rcurl "https://$d/api/version" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.version+"/"+j.commit)})' 2>/dev/null || echo "?")
    [[ "$ver" == "$VERSION/$COMMIT" ]] && ok "$d/api/version = $ver" || bad "$d/api/version = $ver (want $VERSION/$COMMIT)"
  done
  if [[ -n "$LAND" ]]; then
    code=$(rcurl -o /dev/null -w '%{http_code}' "https://$LAND/"); [[ "$code" == 200 ]] && ok "landing https://$LAND/ 200" || bad "landing $LAND → $code"
    code=$(rcurl -o /dev/null -w '%{http_code}' "https://$LAND/download/"); [[ "$code" == 200 ]] && ok "landing /download/ 200" || bad "landing /download/ → $code"
  fi
  code=$(rcurl -o /dev/null -w '%{http_code}' "https://$RTC/"); [[ "$code" == 200 ]] && ok "$RTC/ 200 (LiveKit)" || bad "$RTC/ → $code"
  r=$(on_stand 'curl -s 127.0.0.1:3000/readyz'); [[ "$r" == *'"postgres":"ok"'*'"redis":"ok"'* ]] && ok "readyz (inside): $r" || bad "readyz: $r"

  # 2. /download/: every built file served (200 + exact size), sha512 in latest*.yml recomputed on the stand
  if [[ -d "$OUT" ]]; then
    n_inst=0
    for f in "$OUT"/*; do
      b=$(basename "$f"); size=$(stat -f %z "$f" 2>/dev/null || stat -c %s "$f")
      got=$(rcurl -I "https://$D1/download/$b" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2} /^HTTP/{c=$2} END{print c}' | tr '\n' ' ')
      [[ "$got" == "$size 200 " ]] && ok "/download/$b (200, $size B)" || bad "/download/$b → '$got' (want $size 200)"
      [[ "$b" =~ \.(dmg|zip|AppImage|deb|exe)$ ]] && n_inst=$((n_inst + 1))
    done
    ok "installers built: $n_inst (mac arm64+x64 dmg/zip, AppImage, deb, exe), feeds: $(ls "$OUT"/latest*.yml | wc -l | tr -d ' ')"
  fi
  sha=$(on_stand 'cd /opt/calaba/releases && python3 - <<PY
import base64, hashlib, re, sys
bad = 0; n = 0
for yml in ("latest-mac.yml", "latest-linux.yml", "latest.yml"):
    text = open(yml).read()
    for url, digest in re.findall(r"- url: (\S+)\n\s+sha512: (\S+)", text):
        n += 1
        h = base64.b64encode(hashlib.sha512(open(url, "rb").read()).digest()).decode()
        if h != digest: bad += 1; print("MISMATCH", url)
print(f"{n} files checked, {bad} mismatches")
sys.exit(1 if bad or n == 0 else 0)
PY') && ok "sha512 in latest*.yml match the files on the stand ($sha)" || bad "sha512 check: $sha"

  # credentials for the checks (over ssh, never printed)
  acc="$(on_stand 'cat /opt/calaba/infra/docker/.env.accounts')"
  OWNER_PW="$(awk '/^owner@/{print $2}' <<<"$acc")"; INVITE="$(awk '/^invite /{print $2}' <<<"$acc")"
  api() { rcurl "$@"; }
  login() { api -X POST "https://$D1/api/auth/login" -d "{\"email\":\"$1\",\"password\":\"$2\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).tokens.accessToken||"")}catch{console.log("")}})'; }

  # 3. e2e:web — dedicated accounts per domain (workspace creation is rate-limited per user), created once
  #    with the owner's invite; the workspaces the spec creates are deleted afterwards.
  for pair in "app:$D1" "alias:$D2"; do
    tag="${pair%%:*}"; d="${pair#*:}"; email="e2e-$tag@calaba.test"
    pw="$(awk -v e="$email" '$1==e{print $2}' <<<"$acc")"
    if [[ -z "$pw" ]]; then
      pw="$(openssl rand -hex 12)"
      code=$(api -o /dev/null -w '%{http_code}' -X POST "https://$D1/api/auth/register" \
        -d "{\"email\":\"$email\",\"password\":\"$pw\",\"displayName\":\"E2E $tag\",\"inviteCode\":\"$INVITE\"}")
      [[ "$code" == 20? ]] || { bad "create $email ($code)"; continue; }
      printf '%s %s\n' "$email" "$pw" | on_stand 'umask 077; cat >> /opt/calaba/infra/docker/.env.accounts'
      ok "created e2e account $email (password stored in .env.accounts on the stand)"
    fi
    # both through the IP-forcing config: no dependency on local DNS/VPN
    cfg=../../infra/docker/tools/playwright.stand.config.ts; force_ip="$IP"
    if (cd apps/desktop && CALABA_FORCE_IP="$force_ip" CALABA_WEB_URL="https://$d" CALABA_WEB_LOGIN="$email" \
          CALABA_WEB_PASSWORD="$pw" CALABA_WEB_FF_VOICE=1 pnpm exec playwright test --config "$cfg" >"$WORK.e2e-$tag.log" 2>&1); then
      ok "e2e:web $d (chromium + firefox, voice) — $(grep -oE '[0-9]+ passed' "$WORK.e2e-$tag.log" | tail -1)"
    else
      bad "e2e:web $d — see $WORK.e2e-$tag.log"
    fi
    # cleanup: delete the workspaces the spec created (named "Web <browser>-<id>")
    t="$(login "$email" "$pw")"
    if [[ -n "$t" ]]; then
      ids=$(api "https://$D1/api/workspaces" -H "Authorization: Bearer $t" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const w of JSON.parse(s).workspaces||[]) if(/^Web /.test(w.name)) console.log(w.id)})')
      for id in $ids; do api -o /dev/null -X DELETE "https://$D1/api/workspaces/$id" -H "Authorization: Bearer $t"; done
      ok "cleanup: deleted $(echo $ids | wc -w | tr -d ' ') e2e workspace(s) of $email"
    fi
  done

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
    if node infra/docker/tools/relay-check.mjs "wss://$RTC" "$tok" tls,udp,any | tee "$WORK.relay.log" | sed 's/^/        /'; then
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

# --- tag -------------------------------------------------------------------------------------------
if step tag; then
  if (( FAILS )); then
    log "NOT tagging: $FAILS check(s) failed"
  else
    git tag -a "v$VERSION" "$COMMIT" -m "Calaba $VERSION" && log "tagged v$VERSION → $COMMIT (local only — push is a separate decision)"
  fi
fi

log "done: $FAILS failed check(s)"
exit $(( FAILS > 0 ))
