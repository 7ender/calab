#!/usr/bin/env bash
# Rotates the secrets in /opt/calaba/infra/docker/.env.accounts (lines "email password" and
# "invite <code>"; comments are kept). Runs on the stand; stdout = status lines only, no secrets.
#   accounts: new password generated here, argon2id hash via cmd/pwhash (uploaded to
#             /root/.calaba-hasher-tmp, deleted on exit), sessions revoked + Redis markers, login check.
#   invite:   new workspace invite code (same workspace/creator/max_uses/expiry) swapped in for the
#             old one in one DB transaction, preview check (new 200, old 404).
# Run: ssh root@<stand> 'STEPS=accounts,invite bash -s' < infra/docker/tools/rotate-accounts.sh
set -uo pipefail
umask 077
cd /opt/calaba/infra/docker || exit 1
STEPS="${STEPS:-accounts,invite}"
APP="https://$(grep -m1 '^APP_HOST=' .env | cut -d= -f2- | tr -d "\"'")"
H=/root/.calaba-hasher-tmp
trap 'rm -f "$H" .env.accounts.new' EXIT
ACC0=.env.accounts
mask() { local e="$1"; printf "#%d %s***@%s" "$(idx "$e")" "${e:0:2}" "${e#*@}"; }
idx() { grep -n -F -- "$1 " "$ACC0" | head -1 | cut -d: -f1; }
dc() { docker compose "$@"; }
psqlq() { dc exec -T postgres psql -U calaba -d calaba -v ON_ERROR_STOP=1 -qtA 2>/dev/null; }
# curl with the whole request (URL, token, body) on stdin, never on argv: api METHOD PATH [TOKEN] [JSON]
api() {
  local body="${4:-}"
  { printf 'url = "%s%s"\nrequest = "%s"\nsilent\nheader = "Content-Type: application/json"\n' "$APP" "$2" "$1"
    [[ -n "${3:-}" ]] && printf 'header = "Authorization: Bearer %s"\n' "$3"
    [[ -n "$body" ]] && printf 'data = "%s"\n' "${body//\"/\\\"}"
  } | curl -K - -w '\n%{http_code}'
}
acc_pw() { awk -v e="$1" '$1==e{print $2}' .env.accounts; }

rotate_accounts() {
  local RPW line email new hash out sids nsess nred code pw
  RPW="$(grep -m1 '^REDIS_PASSWORD=' .env | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")"
  local -a done_emails=()
  : > .env.accounts.new
  while IFS= read -r line <&3 || [[ -n "$line" ]]; do
    email="${line%% *}"
    if [[ "$email" != *@* ]]; then printf '%s\n' "$line" >> .env.accounts.new; continue; fi
    new="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
    [[ ${#new} -ge 20 ]] || { echo "$(mask "$email"): FAIL gen"; printf '%s\n' "$line" >> .env.accounts.new; continue; }
    hash="$(printf '%s\n' "$new" | "$H")" || hash=""
    [[ "$hash" == '$argon2id$'* ]] || { echo "$(mask "$email"): FAIL hash"; printf '%s\n' "$line" >> .env.accounts.new; continue; }
    out="$(psqlq <<SQL
\\set h '$hash'
\\set e '$email'
BEGIN;
CREATE TEMP TABLE u ON COMMIT DROP AS SELECT id FROM users WHERE email = :'e';
UPDATE users SET password_hash = :'h' WHERE id IN (SELECT id FROM u);
SELECT 'U ' || count(*) FROM u;
UPDATE sessions SET revoked_at = now() WHERE user_id IN (SELECT id FROM u) AND revoked_at IS NULL RETURNING 'S ' || id;
COMMIT;
SQL
)" || out=""
    if [[ "$(grep -c '^U 1$' <<<"$out")" != 1 ]]; then
      echo "$(mask "$email"): FAIL db (password unchanged)"; printf '%s\n' "$line" >> .env.accounts.new; continue
    fi
    printf '%s %s\n' "$email" "$new" >> .env.accounts.new
    sids="$(awk '/^S /{print $2}' <<<"$out")"
    nsess=0; nred=0
    if [[ -n "$sids" ]]; then
      nsess=$(wc -l <<<"$sids")
      # Access-token markers (auth:revoked:<sid>, TTL > ACCESS_TOKEN_TTL) + gateway socket close.
      nred=$({ printf 'AUTH %s\n' "$RPW"; while read -r s; do printf 'SET auth:revoked:%s 1 EX 1800\nPUBLISH session:revoked:%s ""\n' "$s" "$s"; done <<<"$sids"; } \
        | dc exec -T valkey valkey-cli 2>/dev/null | grep -c '^OK$')
      nred=$((nred - 1))   # minus the AUTH reply
    fi
    done_emails+=("$email")
    echo "$(mask "$email"): rotated, sessions revoked=$nsess, redis markers=$nred"
  done 3< .env.accounts
  chmod 600 .env.accounts.new && mv -f .env.accounts.new .env.accounts
  sleep 1
  for email in "${done_emails[@]}"; do
    pw="$(acc_pw "$email")"
    code=$(api POST /api/auth/login "" "{\"email\":\"$email\",\"password\":\"$pw\"}" | tail -1)
    echo "$(mask "$email"): login $code"
  done
}

rotate_invite() {
  local old newc out
  old="$(awk '$1=="invite"{print $2}' .env.accounts)"
  [[ -n "$old" ]] || { echo "invite: no invite line, skipped"; return; }
  # Same alphabet/length as workspaces.newInviteCode. Done in the DB: the API needs a verified
  # email, which the @calaba.test owner does not have.
  newc="$(LC_ALL=C tr -dc '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ' </dev/urandom | head -c 10)"
  [[ ${#newc} -eq 10 ]] || { echo "invite: FAIL gen"; return; }
  out="$(psqlq <<SQL
\\set o '$old'
\\set n '$newc'
BEGIN;
INSERT INTO workspace_invites (workspace_id, code, created_by, max_uses, expires_at)
SELECT workspace_id, :'n', created_by, max_uses, expires_at FROM workspace_invites WHERE code = :'o'
RETURNING 'I maxUses=' || max_uses || ' expires=' || coalesce(expires_at::text, 'never');
DELETE FROM workspace_invites WHERE code = :'o' RETURNING 'D';
COMMIT;
SQL
)" || out=""
  if ! grep -q '^I ' <<<"$out" || ! grep -q '^D$' <<<"$out"; then echo "invite: FAIL db (unchanged)"; return; fi
  NEWC="$newc" awk '$1=="invite"{print "invite " ENVIRON["NEWC"]; next} {print}' .env.accounts > .env.accounts.new \
    && chmod 600 .env.accounts.new && mv -f .env.accounts.new .env.accounts
  echo "invite: rotated ($(grep '^I ' <<<"$out" | cut -c3-))"
  echo "invite: new preview $(api GET "/api/invites/$newc" | tail -1), old preview $(api GET "/api/invites/$old" | tail -1)"
}

[[ ",$STEPS," == *,accounts,* ]] && rotate_accounts
[[ ",$STEPS," == *,invite,* ]] && rotate_invite
echo "file mode: $(stat -c %a .env.accounts), lines: $(wc -l < .env.accounts)"
