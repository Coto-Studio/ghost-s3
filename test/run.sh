#!/usr/bin/env bash
#
# Builds the image and exercises the adapter against a throwaway MinIO.
# Usage: test/run.sh [base-tag]     (default: 6-alpine)
#
set -euo pipefail

BASE_TAG="${1:-6-alpine}"
IMAGE="ghost-s3:test"
NETWORK="ghost-s3-test"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  docker rm -f minio-test >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Building $IMAGE from ghost:$BASE_TAG"
docker build --build-context "ghost=docker-image://ghost:$BASE_TAG" -t "$IMAGE" "$REPO_ROOT"

echo "==> Starting MinIO"
cleanup
docker network create "$NETWORK" >/dev/null
docker run -d --name minio-test --network "$NETWORK" \
  --network-alias minio \
  -e MINIO_ROOT_USER=testkey -e MINIO_ROOT_PASSWORD=testsecret123 \
  minio/minio server /data >/dev/null

# MinIO needs a moment before it will accept a bucket create.
for _ in $(seq 1 30); do
  if docker run --rm --network "$NETWORK" --entrypoint sh minio/mc -c \
      'mc alias set m http://minio:9000 testkey testsecret123' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker run --rm --network "$NETWORK" --entrypoint sh minio/mc -c \
  'mc alias set m http://minio:9000 testkey testsecret123 >/dev/null && mc mb --ignore-existing m/ghost-test' >/dev/null

echo "==> Running adapter tests"
docker run --rm --network "$NETWORK" \
  -v "$REPO_ROOT/test/adapter.test.js:/tmp/adapter.test.js:ro" \
  --entrypoint node "$IMAGE" /tmp/adapter.test.js
