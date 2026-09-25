#!/usr/bin/env bash
# Deploy the production-like stack on a single host. Run from anywhere:
#   infra/docker/deploy.sh                  # whole stack
#   infra/docker/deploy.sh caddy livekit    # only these services (and their deps)
# Requires infra/docker/.env (see .env.example) and envsubst (gettext-base).
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "infra/docker/.env not found — copy .env.example and fill it in" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

: "${DOMAIN:?DOMAIN is not set in .env}"
: "${LIVEKIT_API_KEY:?LIVEKIT_API_KEY is not set in .env}"

# Substitute only these two variables; everything else in the template stays literal.
cfg=livekit/livekit.gen.yaml
before="$(cat "$cfg" 2>/dev/null | sha256sum)"
envsubst '${DOMAIN} ${LIVEKIT_API_KEY}' < livekit/livekit.yaml.tpl > "$cfg"
after="$(sha256sum < "$cfg")"

docker compose up -d --build --remove-orphans "$@"

# The config is a bind mount: compose doesn't notice content changes, so restart
# LiveKit ourselves when the rendered file changed (brief media interruption).
if [[ "$before" != "$after" ]] && [[ -n "$(docker compose ps -q livekit 2>/dev/null)" ]]; then
  echo "livekit config changed -> restarting livekit"
  docker compose restart livekit
fi
