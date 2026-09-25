#!/usr/bin/env bash
# Restore helpers for backups made by backup.sh. Destructive modes ask for confirmation.
#   restore.sh test  [dump]            # restore into a scratch DB calaba_restore_test, compare row counts, drop it
#   restore.sh pg    <dump>            # REPLACE the live database (stops api first)
#   restore.sh files <files-*.tar.zst> # REPLACE the uploaded files volume (stops api first)
# Default dump = newest in /opt/calaba/backups/pg.
set -euo pipefail
BACKUP_DIR="${BACKUP_DIR:-/opt/calaba/backups}"
PROJECT="${COMPOSE_PROJECT:-calaba}"
PG="${PROJECT}-postgres-1"
COMPOSE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-}"; arg="${2:-}"
newest() { ls -1t "$BACKUP_DIR/$1"/*"$2" 2>/dev/null | head -1; }
psqlc() { docker exec -i "$PG" psql -U calaba -v ON_ERROR_STOP=1 -qAt "$@"; }
confirm() { read -r -p "$1 Type YES: " a; [[ "$a" == YES ]] || { echo aborted; exit 1; }; }
counts() { # table row counts of the public schema, one "table count" per line
  psqlc -d "$1" -c "select format('select %L, count(*) from public.%I', tablename, tablename) from pg_tables where schemaname='public' order by 1" \
    | { q=""; while read -r l; do q+="$l union all "; done; [[ -n "$q" ]] && psqlc -d "$1" -F' ' -c "${q% union all }" | sort; }
}

case "$mode" in
  test)
    dump="${arg:-$(newest pg .dump)}"; [[ -f "$dump" ]] || { echo "no dump"; exit 1; }
    echo "restore test of $dump"
    psqlc -d postgres -c "drop database if exists calaba_restore_test" -c "create database calaba_restore_test"
    docker exec -i "$PG" pg_restore -U calaba -d calaba_restore_test --no-owner --exit-on-error < "$dump"
    a="$(counts calaba_restore_test)"; b="$(counts calaba)"
    echo "tables restored: $(echo "$a" | wc -l)"
    if [[ "$a" == "$b" ]]; then echo "row counts: identical to live DB"; else echo "row counts differ from live DB (expected if data changed since the dump):"; diff <(echo "$b") <(echo "$a") || true; fi
    psqlc -d postgres -c "drop database calaba_restore_test"
    echo "restore test OK (calaba_restore_test dropped)";;
  pg)
    dump="$arg"; [[ -f "$dump" ]] || { echo "usage: restore.sh pg <dump>"; exit 1; }
    confirm "This REPLACES database 'calaba' with $dump."
    (cd "$COMPOSE_DIR" && docker compose stop api)
    psqlc -d postgres -c "drop database calaba with (force)" -c "create database calaba owner calaba"
    docker exec -i "$PG" pg_restore -U calaba -d calaba --no-owner --exit-on-error < "$dump"
    (cd "$COMPOSE_DIR" && docker compose start api)
    echo "database restored";;
  files)
    tarf="$arg"; [[ -f "$tarf" ]] || { echo "usage: restore.sh files <files-*.tar.zst>"; exit 1; }
    root="$(docker volume inspect -f '{{.Mountpoint}}' "${PROJECT}_files_data")"
    confirm "This REPLACES all uploaded files in $root with $tarf."
    (cd "$COMPOSE_DIR" && docker compose stop api)
    find "$root" -mindepth 1 -delete
    zstd -dc "$tarf" | tar -C "$root" -xpf -
    chown -R 65532:65532 "$root"
    (cd "$COMPOSE_DIR" && docker compose start api)
    echo "files restored";;
  *) sed -n '2,7p' "$0"; exit 1;;
esac
