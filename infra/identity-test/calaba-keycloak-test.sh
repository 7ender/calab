#!/usr/bin/env bash
# Live RP acceptance against an already retained local fixture. No startup/reset.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
: "${IDENTITY_TEST_HARNESS:?Set the absolute path to the retained ORIGINAL tools/identity-test-env.sh}"
version=${1:-18}
case "$version" in 18|17) ;; *) echo 'Use PostgreSQL 18 or 17' >&2; exit 2 ;; esac
endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
case "$endpoint" in unix://*|npipe://*) ;; *) echo 'Local Docker socket required' >&2; exit 2 ;; esac
ports=$("$IDENTITY_TEST_HARNESS" ports)
project=${ports%%$'\n'*}
project=${project#project=}
[[ $project =~ ^calaba-identity-test-[a-f0-9]{10}$ ]] || { echo 'Invalid fixture project' >&2; exit 2; }
eval "$("$IDENTITY_TEST_HARNESS" env "$version" qa)"
[[ $TEST_PG_URL == */identity_qa ]] || { echo 'Expected original QA database URL' >&2; exit 2; }
export TEST_PG_URL="${TEST_PG_URL%/identity_qa}/identity_keycloak"
export TEST_DATABASE_URL="$TEST_PG_URL"
# Only create this worker's database, never drop/reset an existing one.
printf '%s\n' "SELECT 'CREATE DATABASE identity_keycloak' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='identity_keycloak')\gexec" |
  docker exec -i "$project-pg$version-1" psql -U identity_test -d identity_test -v ON_ERROR_STOP=1
export CALABA_KEYCLOAK_LIVE=1
export TEST_KEYCLOAK_ADMIN_USER=fixture-admin
export TEST_KEYCLOAK_ADMIN_PASSWORD=fixture-only-admin-password
# The RP package uses no Valkey: quota/token delivery are explicit root seams.
printf 'Live Keycloak RP acceptance: SHA=%s PostgreSQL=%s DB=identity_keycloak\n' "$(git -C "$root" rev-parse HEAD)" "$version"
cd "$root/apps/server"
go test -race -tags integration -count=1 -timeout 3m -v -run '^TestKeycloakLiveRP$' ./internal/sso
