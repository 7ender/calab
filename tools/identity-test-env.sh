#!/usr/bin/env bash
# Disposable local dependencies; never call the development/production compose files.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
namespace=$(printf '%s' "$root" | shasum -a 256 | cut -c1-10)
export IDENTITY_TEST_PROJECT="calaba-identity-test-$namespace"
export IDENTITY_TEST_RUNTIME="$root/infra/identity-test/.runtime/$namespace"
base=${IDENTITY_TEST_PORT_BASE:-57400}
if ! [[ $base =~ ^[0-9]{1,5}$ ]]; then
  echo 'IDENTITY_TEST_PORT_BASE must be an integer from 1024 to 65440' >&2; exit 2
fi
base=$((10#$base))
if ((base < 1024 || base > 65440)); then
  echo 'IDENTITY_TEST_PORT_BASE must be an integer from 1024 to 65440' >&2; exit 2
fi
if [[ -f "$IDENTITY_TEST_RUNTIME/port-base" ]]; then
  saved=$(cat "$IDENTITY_TEST_RUNTIME/port-base")
  if [[ -n ${IDENTITY_TEST_PORT_BASE:-} && $base != "$saved" ]]; then
    echo 'Port base already reserved; teardown before changing it.' >&2; exit 2
  fi
  base=$saved
fi
export IDENTITY_TEST_PG18_PORT=$((base + 18)) IDENTITY_TEST_PG17_PORT=$((base + 17))
export IDENTITY_TEST_REDIS_QA_PORT=$((base + 79))
export IDENTITY_TEST_REDIS_FOUNDATION_PORT=$((base + 81)) IDENTITY_TEST_REDIS_RP_PORT=$((base + 82))
export IDENTITY_TEST_REDIS_PROVIDER_PORT=$((base + 83)) IDENTITY_TEST_REDIS_ENFORCEMENT_PORT=$((base + 84))
export IDENTITY_TEST_OIDC_PORT=$((base + 80)) IDENTITY_TEST_RTC_PORT=$((base + 88))
export IDENTITY_TEST_RTC_TCP_PORT=$((base + 89)) IDENTITY_TEST_RTC_UDP_PORT=$((base + 90))
compose() {
  # Reject remote engines; this task owns local dependencies only.
  local endpoint
  endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
  case "$endpoint" in unix://*|npipe://*) ;; *) echo 'Local Docker socket required' >&2; return 2 ;; esac
  docker compose --env-file /dev/null -p "$IDENTITY_TEST_PROJECT" \
    -f "$root/infra/docker/identity-test.compose.yml" --profile '*' "$@"
}
role=${3:-qa}
version=${2:-18}
validate_role() {
  case "$role" in qa|foundation|rp|provider|enforcement) ;; *) echo 'Unknown worker role' >&2; exit 2 ;; esac
  case "$version" in 17|18) ;; *) echo 'PostgreSQL version must be 17 or 18' >&2; exit 2 ;; esac
}
emit_env() {
  validate_role
  local pgvar="IDENTITY_TEST_PG${version}_PORT" redisvar
  redisvar="IDENTITY_TEST_REDIS_$(printf '%s' "$role" | tr '[:lower:]' '[:upper:]')_PORT"
  local pgurl="postgres://identity_test:fixture-only-password@127.0.0.1:${!pgvar}/identity_${role}"
  printf 'export TEST_PG_URL=%q\nexport TEST_DATABASE_URL=%q\n' "$pgurl" "$pgurl"
  printf 'export TEST_REDIS_URL=%q\nexport TEST_RTC_REDIS_DB=14\n' "redis://127.0.0.1:${!redisvar}/15"
  printf 'export TEST_REDIS_KEY_PREFIX=%q\n' "identity-test:$namespace:$role:pg$version:"
  printf 'export TEST_LIVEKIT_URL=%q\nexport TEST_LIVEKIT_INTERNAL_URL=%q\n' \
    "ws://127.0.0.1:$IDENTITY_TEST_RTC_PORT" "http://127.0.0.1:$IDENTITY_TEST_RTC_PORT"
  printf 'export TEST_OIDC_ISSUER=%q\nexport TEST_OIDC_CA_FILE=%q\n' \
    "https://127.0.0.1:$IDENTITY_TEST_OIDC_PORT/realms/identity.test" "$IDENTITY_TEST_RUNTIME/tls/localhost.crt"
  printf 'export TEST_OIDC_CLIENT_ID=calaba-identity-test\nexport TEST_OIDC_CLIENT_SECRET=fixture-only-client-secret\n'
  printf 'export TEST_OIDC_REDIRECT_URI=http://127.0.0.1:57500/identity-test/callback\n'
}
case "${1:-help}" in
  env) emit_env ;;
  config) compose config --quiet ;;
  ports)
    printf 'project=%s\nPG18=%s PG17=%s OIDC=%s RTC=%s/%s/%s\n' "$IDENTITY_TEST_PROJECT" \
      "$IDENTITY_TEST_PG18_PORT" "$IDENTITY_TEST_PG17_PORT" "$IDENTITY_TEST_OIDC_PORT" \
      "$IDENTITY_TEST_RTC_PORT" "$IDENTITY_TEST_RTC_TCP_PORT" "$IDENTITY_TEST_RTC_UDP_PORT"
    printf 'Valkey qa=%s foundation=%s rp=%s provider=%s enforcement=%s\n' \
      "$IDENTITY_TEST_REDIS_QA_PORT" "$IDENTITY_TEST_REDIS_FOUNDATION_PORT" "$IDENTITY_TEST_REDIS_RP_PORT" \
      "$IDENTITY_TEST_REDIS_PROVIDER_PORT" "$IDENTITY_TEST_REDIS_ENFORCEMENT_PORT" ;;
  up)
    shift
    services=()
    for profile in "${@:-core}"; do
      case "$profile" in
        core) services+=(pg18 valkey-qa) ;;
        pg17) services+=(pg17) ;;
        foundation|rp|provider|enforcement) services+=(pg18 "valkey-$profile") ;;
        oidc|rtc) services+=("$profile") ;;
        *) echo "Unknown profile: $profile" >&2; exit 2 ;;
      esac
    done
    mkdir -p "$IDENTITY_TEST_RUNTIME"
    printf '%s\n' "$base" > "$IDENTITY_TEST_RUNTIME/port-base"
    if [[ " ${services[*]} " == *' oidc '* && ! -f "$IDENTITY_TEST_RUNTIME/tls/localhost.crt" ]]; then
      mkdir -p "$IDENTITY_TEST_RUNTIME/tls"
      openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 30 -subj '/CN=localhost' \
        -addext 'subjectAltName=DNS:localhost,DNS:identity.test,IP:127.0.0.1' \
        -keyout "$IDENTITY_TEST_RUNTIME/tls/localhost.key" -out "$IDENTITY_TEST_RUNTIME/tls/localhost.crt" 2>/dev/null
      # This throwaway, untrusted test key must be readable by the container's non-root UID.
      chmod 644 "$IDENTITY_TEST_RUNTIME/tls/localhost.key"
    fi
    compose up -d --wait --wait-timeout 180 "${services[@]}"
    if [[ " ${services[*]} " == *' oidc '* ]]; then
      version=18 role=qa
      eval "$(emit_env)"
      python3 "$root/infra/identity-test/oidc-smoke.py" --ready
    fi
    ;;
  create-db)
    validate_role
    # Validated role is a closed enum; no user input is interpolated as an SQL identifier.
    printf "SELECT 'CREATE DATABASE identity_%s' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='identity_%s')\\\\gexec\n" "$role" "$role" | \
      compose exec -T "pg$version" psql -U identity_test -d identity_test -v ON_ERROR_STOP=1
    ;;
  status) compose ps ;;
  smoke)
    validate_role
    compose exec -T "pg$version" psql -U identity_test -d "identity_$role" -v ON_ERROR_STOP=1 \
      -c 'SELECT version();'
    compose exec -T "valkey-$role" valkey-cli ping
    ;;
  oidc-smoke)
    eval "$(emit_env)"
    python3 "$root/infra/identity-test/oidc-smoke.py"
    ;;
  down)
    compose down --volumes
    rm -rf -- "$IDENTITY_TEST_RUNTIME"
    ;;
  *)
    echo 'Usage: tools/identity-test-env.sh {ports|config|up [core pg17 oidc rtc foundation rp provider enforcement]|env [18|17] [role]|create-db [18|17] [role]|smoke [18|17] [role]|oidc-smoke|status|down}'
    ;;
esac
