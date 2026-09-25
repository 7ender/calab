#!/usr/bin/env bash
# Push the working tree to the stand and deploy it there (no git on the host).
#   infra/docker/sync.sh                               # sync + deploy whole stack
#   infra/docker/sync.sh caddy livekit postgres redis         # sync + deploy only these
#   SYNC_ONLY=1 infra/docker/sync.sh                   # sync files, don't deploy
# Env: STAND_HOST (default root@141.105.69.177), STAND_DIR (default /opt/calaba).
# The host keeps its own infra/docker/.env (secrets) — it is never overwritten or deleted.
# Web client (ADR-0015): if apps/desktop/dist-web exists locally it is pushed to $DIR/web
# (mounted into caddy as /srv/web); otherwise a placeholder is seeded once if $DIR/web is empty.
# Releases: if apps/desktop/dist-release exists locally, it is pushed to $DIR/releases
# (/download/* and the electron-updater feed) WITHOUT --delete: old versions stay downloadable.
# SKIP_WEB=1 / SKIP_RELEASES=1 skip those steps.
set -euo pipefail

HOST="${STAND_HOST:-root@141.105.69.177}"
DIR="${STAND_DIR:-/opt/calaba}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SSH=(ssh -o BatchMode=yes)

"${SSH[@]}" "$HOST" "mkdir -p '$DIR'"

# --delete keeps the host tree identical to ours; excluded paths (secrets, rendered
# config, build outputs) are protected from deletion. First matching rule wins.
rsync -az --no-owner --no-group --delete -e "ssh -o BatchMode=yes" \
  --exclude node_modules --exclude .git --exclude dist --exclude dist-web --exclude out \
  --exclude '/web/' --exclude '/releases/' --exclude dist-release \
  --exclude .turbo --exclude coverage --exclude .DS_Store \
  --include '.env.example' --exclude '.env' --exclude '.env.*' \
  --exclude 'infra/docker/livekit/livekit.gen.yaml' \
  --exclude 'infra/docker/data/' \
  "$ROOT/" "$HOST:$DIR/"

# Web static: new hashed assets land first, index.html and deletions last (--delay-updates,
# --delete-after), so a browser never gets an index.html pointing at missing assets.
WEB_SRC="$ROOT/apps/desktop/dist-web"
if [[ -n "${SKIP_WEB:-}" ]]; then
  echo "web: skipped (SKIP_WEB)"
elif [[ -f "$WEB_SRC/index.html" ]]; then
  rsync -az --no-owner --no-group --delete-after --delay-updates --exclude '*.map' -e "ssh -o BatchMode=yes" "$WEB_SRC/" "$HOST:$DIR/web/"
  echo "web: pushed apps/desktop/dist-web"
else
  "${SSH[@]}" "$HOST" "mkdir -p '$DIR/web' && { test -f '$DIR/web/index.html' || cp '$DIR/infra/docker/web-placeholder/index.html' '$DIR/web/'; }"
  echo "web: no local dist-web, kept existing (or placeholder)"
fi

# Releases: installers first, latest*.yml last (--delay-updates), so the updater never sees
# metadata pointing at a file that is not there yet. No --delete.
REL_SRC="$ROOT/apps/desktop/dist-release"
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

# Service names are passed through to deploy.sh -> docker compose up.
"${SSH[@]}" "$HOST" "$DIR/infra/docker/deploy.sh $*"
