#!/usr/bin/env bash
# Cloud Agent install phase: durable, idempotent repository setup.
# Installs Docker + the backing-service images, then builds the app.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=/dev/null
source "$REPO_ROOT/.cursor/setup/stack.env"
# shellcheck source=/dev/null
source "$REPO_ROOT/.cursor/setup/docker-lib.sh"

# 1. Docker engine + fuse-overlayfs (nested-VM storage driver).
# Builds have no TTY; keep apt noninteractive so conffile prompts (e.g. fuse.conf)
# cannot hang or fail the install phase.
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker engine and fuse-overlayfs"
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update
  sudo apt-get install -y \
    -o Dpkg::Options::="--force-confdef" \
    -o Dpkg::Options::="--force-confold" \
    docker.io fuse-overlayfs
fi
sudo mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  echo '{"iptables":false,"storage-driver":"fuse-overlayfs","bridge":"none"}' \
    | sudo tee /etc/docker/daemon.json >/dev/null
fi

# 2. Pull the backing-service images now so they are cached in the snapshot.
ensure_dockerd
for img in "$MONGO_IMAGE" "$MEILI_IMAGE" "$VECTORDB_IMAGE" "$RAG_IMAGE"; do
  echo "==> Pulling $img"
  sudo docker pull "$img"
done

# 3. Generate config, install npm deps, and build packages + client.
bash "$REPO_ROOT/.cursor/setup/build-app.sh"

echo "==> Install phase complete"
