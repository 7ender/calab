#!/usr/bin/env bash
# Copy release/CI secrets from the owner's root .env into GitHub Actions secrets (docs/06, "Релизы: GitHub
# Actions → S3"). Values are never printed.
#
#   infra/ci/set-secrets.sh [--dry-run] [path/to/.env]      # default: <repo>/.env
#
# Auth: an existing `gh auth login`, or GITHUB_TOKEN (fine-grained, "Secrets: read and write" on the repo),
# which is passed to gh as GH_TOKEN. Repo: GITHUB_REPO (default itrcz/calab).
#
# Recognised keys (only non-empty ones are set; anything else in .env, e.g. CFTOKEN, is ignored):
#   S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
#   MAC_CSC_LINK MAC_CSC_KEY_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
#   WIN_CSC_LINK WIN_CSC_KEY_PASSWORD
#   STAND_SSH_KEY STAND_HOST STAND_KNOWN_HOSTS
# File values: MAC_CSC_LINK / WIN_CSC_LINK may be a path to the .p12/.pfx (base64-encoded here, as
# electron-builder expects), APPLE_API_KEY / STAND_SSH_KEY / STAND_KNOWN_HOSTS may be paths (content is sent).
set -euo pipefail

dry=0; [[ "${1:-}" == --dry-run ]] && { dry=1; shift; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${1:-$ROOT/.env}"
REPO="${GITHUB_REPO:-itrcz/calab}"
[[ -f "$ENV_FILE" ]] || { echo "no $ENV_FILE" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh CLI required (brew install gh)" >&2; exit 1; }
[[ -n "${GITHUB_TOKEN:-}" ]] && export GH_TOKEN="$GITHUB_TOKEN"
if (( ! dry )); then
  gh auth status >/dev/null 2>&1 || [[ -n "${GH_TOKEN:-}" ]] || { echo "not authenticated: gh auth login, or GITHUB_TOKEN=…" >&2; exit 1; }
fi

KEYS=(S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
      MAC_CSC_LINK MAC_CSC_KEY_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
      WIN_CSC_LINK WIN_CSC_KEY_PASSWORD
      STAND_SSH_KEY STAND_HOST STAND_KNOWN_HOSTS)

# read KEY=VALUE without sourcing (no command execution from .env); strip optional surrounding quotes
value_of() {
  local line v
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ENV_FILE" | tail -1)" || return 0
  v="${line#*=}"; v="${v%$'\r'}"
  [[ "$v" == \"*\" || "$v" == \'*\' ]] && v="${v:1:${#v}-2}"
  v="${v/#\~/$HOME}"
  printf '%s' "$v"
}

set_n=0 skip_n=0
for k in "${KEYS[@]}"; do
  v="$(value_of "$k")"
  if [[ -z "$v" ]]; then skip_n=$((skip_n + 1)); continue; fi
  kind="value"
  case "$k" in
    MAC_CSC_LINK|WIN_CSC_LINK)
      if [[ -f "$v" ]]; then v="$(base64 < "$v" | tr -d '\n')"; kind="file→base64"; fi ;;
    APPLE_API_KEY|STAND_SSH_KEY|STAND_KNOWN_HOSTS)
      if [[ -f "$v" ]]; then v="$(cat "$v")"; kind="file"; fi ;;
  esac
  if (( dry )); then
    echo "would set $k ($kind, ${#v} chars)"
  else
    printf '%s' "$v" | gh secret set "$k" --repo "$REPO" --body - >/dev/null
    echo "set $k ($kind)"
  fi
  set_n=$((set_n + 1))
done
echo "$([[ $dry == 1 ]] && echo 'dry run: ')$set_n secret(s) for $REPO, $skip_n key(s) absent/empty in $(basename "$ENV_FILE")"
if (( ! dry )) && [[ -z "$(value_of S3_BUCKET)" && -z "$(value_of STAND_HOST)" ]]; then
  echo "note: neither S3_* nor STAND_* set — tagged releases will build but not be published" >&2
fi
