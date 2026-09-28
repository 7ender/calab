#!/usr/bin/env bash
# Starts a single-node Garage (S3 API) for the s3 driver's integration tests, creates a bucket
# and a key, and prints the TEST_S3_* variables as KEY=VALUE lines (CI appends them to
# $GITHUB_ENV). Locally, from apps/server:
#
#   set -a; eval "$(GARAGE_PORT=53900 internal/blob/testdata/garage.sh)"; set +a
#   go test -tags integration -run S3 ./internal/blob/
#   internal/blob/testdata/garage.sh rm
#
# GARAGE_NAME (container, default calab-garage) and GARAGE_PORT (S3 API on 127.0.0.1, default
# 3900) keep parallel runs apart. The key is random per start; nothing is kept on disk.
set -euo pipefail

image=dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020
name=${GARAGE_NAME:-calab-garage}
port=${GARAGE_PORT:-3900}
bucket=calab-test

if [ "${1:-}" = rm ]; then
  docker rm -f "$name" >/dev/null
  exit 0
fi

dir=$(cd "$(dirname "$0")" && pwd)
docker run -d --name "$name" -p "127.0.0.1:$port:3900" -e "GARAGE_RPC_SECRET=$(openssl rand -hex 32)" \
  -v "$dir/garage.toml:/etc/garage.toml:ro" "$image" >/dev/null
g() { docker exec -e RUST_LOG=warn "$name" /garage "$@"; }
for i in $(seq 1 30); do
  if g status >/dev/null 2>&1; then break; fi
  if [ "$i" = 30 ]; then docker logs "$name" >&2; exit 1; fi
  sleep 1
done
node=$(g node id -q | cut -d@ -f1)
g layout assign -z dc1 -c 1G "$node" >/dev/null
g layout apply --version 1 >/dev/null
g bucket create "$bucket" >/dev/null
key_id=GK$(openssl rand -hex 12)
secret=$(openssl rand -hex 32)
g key import --yes -n "$bucket" "$key_id" "$secret" >/dev/null
g bucket allow --read --write --owner "$bucket" --key "$key_id" >/dev/null

cat <<EOF
TEST_S3_ENDPOINT=http://127.0.0.1:$port
TEST_S3_REGION=garage
TEST_S3_BUCKET=$bucket
TEST_S3_ACCESS_KEY_ID=$key_id
TEST_S3_SECRET_ACCESS_KEY=$secret
EOF
