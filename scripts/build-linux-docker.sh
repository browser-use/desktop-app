#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-desktop-app-linux-package:local}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed, but the daemon is not running."
  echo "Start Docker Desktop, then rerun: task linux:make:docker"
  exit 1
fi

docker build \
  --platform "$DOCKER_PLATFORM" \
  -f "$ROOT_DIR/docker/linux.Dockerfile" \
  -t "$IMAGE_TAG" \
  "$ROOT_DIR"

container_id="$(docker create "$IMAGE_TAG")"
tmp_dir="$(mktemp -d)"
cleanup() {
  docker rm "$container_id" >/dev/null 2>&1 || true
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

mkdir -p "$ROOT_DIR/my-app/out/make"
rm -rf \
  "$ROOT_DIR/my-app/out/make/deb" \
  "$ROOT_DIR/my-app/out/make/rpm" \
  "$ROOT_DIR/my-app/out/make/appimage" \
  "$ROOT_DIR/my-app/out/make/latest-linux.yml"
docker cp "$container_id:/workspace/my-app/out/make" "$tmp_dir/make"
cp -R "$tmp_dir/make/." "$ROOT_DIR/my-app/out/make/"

node "$ROOT_DIR/scripts/verify-linux-artifacts.mjs"
