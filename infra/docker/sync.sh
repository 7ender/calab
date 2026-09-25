#!/usr/bin/env bash
# Push the working tree to the stand and deploy it there (no git on the host).
#   infra/docker/sync.sh                               # sync + deploy whole stack
#   infra/docker/sync.sh caddy livekit postgres redis         # sync + deploy only these
#   SYNC_ONLY=1 infra/docker/sync.sh                   # sync files, don't deploy
# Env: STAND_HOST (default root@141.105.69.177), STAND_DIR (default /opt/calaba).
# The host keeps its own infra/docker/.env (secrets) — it is never overwritten or deleted.
set -euo pipefail

HOST="${STAND_HOST:-root@141.105.69.177}"
DIR="${STAND_DIR:-/opt/calaba}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SSH=(ssh -o BatchMode=yes)

"${SSH[@]}" "$HOST" "mkdir -p '$DIR'"

# --delete keeps the host tree identical to ours; excluded paths (secrets, rendered
# config, build outputs) are protected from deletion. First matching rule wins.
rsync -az --delete -e "ssh -o BatchMode=yes" \
  --exclude node_modules --exclude .git --exclude dist --exclude out \
  --exclude .turbo --exclude coverage --exclude .DS_Store \
  --include '.env.example' --exclude '.env' --exclude '.env.*' \
  --exclude 'infra/docker/livekit/livekit.gen.yaml' \
  --exclude 'infra/docker/data/' \
  "$ROOT/" "$HOST:$DIR/"

if [[ -n "${SYNC_ONLY:-}" ]]; then
  echo "synced to $HOST:$DIR (deploy skipped)"
  exit 0
fi

# Service names are passed through to deploy.sh -> docker compose up.
"${SSH[@]}" "$HOST" "$DIR/infra/docker/deploy.sh $*"
