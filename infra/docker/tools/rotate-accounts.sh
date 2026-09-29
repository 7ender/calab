#!/usr/bin/env bash
# Rotates the e2e/test account passwords in .env.accounts (lines "email password"; other lines
# — comments, "invite <code>" — are kept as is): new argon2id hash (cmd/pwhash, uploaded to
# /root/.calaba-hasher-tmp and deleted on exit), sessions revoked + Redis markers, login check.
# Run: ssh root@<stand> 'bash -s' < infra/docker/tools/rotate-accounts.sh. Stdout = status lines only.
set -uo pipefail
umask 077
cd /opt/calaba/infra/docker || exit 1
H=/root/.calaba-hasher-tmp
trap 'rm -f "$H" .env.accounts.new' EXIT
mask() { local e="$1"; printf "#%d %s***@%s" "$(idx "$e")" "${e:0:2}" "${e#*@}"; }
idx() { grep -n -F -- "$1 " "$ACC0" | head -1 | cut -d: -f1; }
dc() { docker compose "$@"; }
RPW="$(grep -m1 '^REDIS_PASSWORD=' .env | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")"
ACC0=.env.accounts; : > .env.accounts.new
declare -a done_emails=()
while IFS= read -r line <&3 || [[ -n "$line" ]]; do
  email="${line%% *}"
  if [[ "$email" != *@* ]]; then printf '%s\n' "$line" >> .env.accounts.new; continue; fi
  new="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  [[ ${#new} -ge 20 ]] || { echo "$(mask "$email"): FAIL gen"; printf '%s\n' "$line" >> .env.accounts.new; continue; }
  hash="$(printf '%s\n' "$new" | "$H")" || hash=""
  [[ "$hash" == '$argon2id$'* ]] || { echo "$(mask "$email"): FAIL hash"; printf '%s\n' "$line" >> .env.accounts.new; continue; }
  out="$(dc exec -T postgres psql -U calaba -d calaba -v ON_ERROR_STOP=1 -qtA 2>/dev/null <<SQL
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
  pw="$(awk -v e="$email" '$1==e{print $2}' .env.accounts)"
  code=$(printf '{"email":"%s","password":"%s"}' "$email" "$pw" | curl -s -o /dev/null -w '%{http_code}' \
    -X POST https://app.calab.ru/api/auth/login -H 'Content-Type: application/json' --data-binary @- || echo 000)
  echo "$(mask "$email"): login $code"
done
echo "file mode: $(stat -c %a .env.accounts), lines: $(wc -l < .env.accounts)"
