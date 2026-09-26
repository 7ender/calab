#!/usr/bin/env bash
# Push the working tree to the stand and deploy it there (no git on the host).
#   infra/docker/sync.sh                               # sync + deploy whole stack
#   infra/docker/sync.sh caddy livekit postgres valkey        # sync + deploy only these
#   SYNC_ONLY=1 infra/docker/sync.sh                   # sync files, don't deploy
# Env: STAND_HOST (default root@141.105.69.177), STAND_DIR (default /opt/calaba).
# The host keeps its own infra/docker/.env (secrets) — it is never overwritten or deleted.
# Web client (ADR-0015): if apps/desktop/dist-web exists locally it is pushed to $DIR/web
# (mounted into caddy as /srv/web); otherwise a placeholder is seeded once if $DIR/web is empty.
# Releases: if apps/desktop/dist-release exists locally, it is pushed to $DIR/releases
# (/download/* and the electron-updater feed) WITHOUT --delete: old versions stay downloadable.
# Landing: apps/landing/out (LANDING_DIST) → $DIR/landing (LANDING_HOST).
# SKIP_WEB=1 / SKIP_RELEASES=1 / SKIP_LANDING=1 skip those steps; WEB_DIST= / RELEASE_DIST= point them at other dirs
# (infra/docker/release.sh uses the web/release builds of the release commit).
# SYNC_REF=<git ref>: deploy that commit (clean `git archive` export) instead of the working tree —
# use it whenever others have uncommitted work in the tree. Web/release artifacts (not in git) still
# come from the working tree.
# Build info for GET /api/version: CALABA_COMMIT (short sha of SYNC_REF, or HEAD[-dirty] for the working
# tree) and CALABA_VERSION (VERSION env, else apps/desktop/package.json) are passed to deploy.sh → compose
# build args.
set -euo pipefail

HOST="${STAND_HOST:-root@141.105.69.177}"
DIR="${STAND_DIR:-/opt/calaba}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SSH=(ssh -o BatchMode=yes)

"${SSH[@]}" "$HOST" "mkdir -p '$DIR'"

# Source tree to deploy: the working tree, or a clean export of SYNC_REF.
SRC_TREE="$ROOT"
if [[ -n "${SYNC_REF:-}" ]]; then
  SRC_TREE="$(mktemp -d "${TMPDIR:-/tmp}/calaba-sync.XXXXXX")"
  trap 'rm -rf "$SRC_TREE"' EXIT
  git -C "$ROOT" archive "$SYNC_REF" | tar -x -C "$SRC_TREE"
  CALABA_COMMIT="$(git -C "$ROOT" rev-parse --short "$SYNC_REF")"
  echo "sync: $SYNC_REF ($CALABA_COMMIT), clean export"
else
  CALABA_COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)"
  [[ -n "$(git -C "$ROOT" status --porcelain -- apps/server infra proto packages 2>/dev/null)" ]] && CALABA_COMMIT+="-dirty"
  echo "sync: working tree ($CALABA_COMMIT)"
fi
CALABA_VERSION="${VERSION:-$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$SRC_TREE/apps/desktop/package.json" | head -1)}"

# --delete keeps the host tree identical to ours; excluded paths (secrets, rendered
# config, build outputs) are protected from deletion. First matching rule wins.
rsync -az --no-owner --no-group --delete -e "ssh -o BatchMode=yes" \
  --exclude node_modules --exclude .git --exclude 'dist*/' --exclude out \
  --exclude 'apps/server/data/' --exclude test-results --exclude playwright-report \
  --exclude '*.log' --exclude '*.tsbuildinfo' \
  --exclude '/web/' --exclude '/releases/' --exclude '/backups/' --exclude '/landing/' \
  --exclude .turbo --exclude coverage --exclude .DS_Store \
  --include '.env.example' --exclude '.env' --exclude '.env.*' \
  --exclude 'infra/docker/livekit/livekit.gen.yaml' \
  --exclude 'infra/docker/data/' \
  "$SRC_TREE/" "$HOST:$DIR/"

# Web static: new hashed assets land first, index.html and deletions last (--delay-updates,
# --delete-after), so a browser never gets an index.html pointing at missing assets.
WEB_SRC="${WEB_DIST:-$ROOT/apps/desktop/dist-web}"
if [[ -n "${SKIP_WEB:-}" ]]; then
  echo "web: skipped (SKIP_WEB)"
elif [[ -f "$WEB_SRC/index.html" ]]; then
  rsync -az --no-owner --no-group --delete-after --delay-updates --exclude '*.map' -e "ssh -o BatchMode=yes" "$WEB_SRC/" "$HOST:$DIR/web/"
  echo "web: pushed apps/desktop/dist-web"
else
  "${SSH[@]}" "$HOST" "mkdir -p '$DIR/web' && { test -f '$DIR/web/index.html' || cp '$DIR/infra/docker/web-placeholder/index.html' '$DIR/web/'; }"
  echo "web: no local dist-web, kept existing (or placeholder)"
fi

# Landing (LANDING_HOST, docs/10-branding.md): Next.js static export, same publish semantics as the web
# client; a placeholder is seeded once if nothing was ever published.
LANDING_SRC="${LANDING_DIST:-$ROOT/apps/landing/out}"
if [[ -n "${SKIP_LANDING:-}" ]]; then
  echo "landing: skipped (SKIP_LANDING)"
elif [[ -f "$LANDING_SRC/index.html" ]]; then
  rsync -az --no-owner --no-group --delete-after --delay-updates --exclude '*.map' -e "ssh -o BatchMode=yes" "$LANDING_SRC/" "$HOST:$DIR/landing/"
  echo "landing: pushed $LANDING_SRC"
else
  "${SSH[@]}" "$HOST" "mkdir -p '$DIR/landing' && { test -f '$DIR/landing/index.html' || cp '$DIR/infra/docker/web-placeholder/index.html' '$DIR/landing/'; }"
  echo "landing: no local build, kept existing (or placeholder)"
fi

# Releases: installers first, latest*.yml last (--delay-updates), so the updater never sees
# metadata pointing at a file that is not there yet. No --delete.
REL_SRC="${RELEASE_DIST:-$ROOT/apps/desktop/dist-release}"
"${SSH[@]}" "$HOST" "mkdir -p '$DIR/releases'"
if [[ -z "${SKIP_RELEASES:-}" && -d "$REL_SRC" ]]; then
  rsync -az --no-owner --no-group --delay-updates \
    --include '*.dmg' --include '*.zip' --include '*.AppImage' --include '*.deb' --include '*.exe' \
    --include '*.blockmap' --include 'latest*.yml' --include '*.json' --exclude '*' \
    -e "ssh -o BatchMode=yes" "$REL_SRC/" "$HOST:$DIR/releases/"
  echo "releases: pushed apps/desktop/dist-release"
fi

if [[ -n "${SYNC_ONLY:-}" ]]; then
  echo "synced to $HOST:$DIR (deploy skipped)"
  exit 0
fi

# Service names are passed through to deploy.sh -> docker compose up (shell-quoted for ssh).
args=""; (( $# )) && args="$(printf '%q ' "$@")"
"${SSH[@]}" "$HOST" "CALABA_COMMIT=$(printf %q "$CALABA_COMMIT") CALABA_VERSION=$(printf %q "$CALABA_VERSION") $DIR/infra/docker/deploy.sh $args"
