#!/usr/bin/env bash
# Shared Docker helpers for the LibreChat Cloud Agent dev stack.
# The Cloud Agent VM runs Docker rootful with fuse-overlayfs and host
# networking (bridge/iptables are unavailable in the nested VM).

# Ensure the Docker daemon is running; start it detached if not.
ensure_dockerd() {
  if sudo docker info >/dev/null 2>&1; then
    return 0
  fi
  echo "==> Starting dockerd"
  sudo mkdir -p /etc/docker
  if [ ! -f /etc/docker/daemon.json ]; then
    echo '{"iptables":false,"storage-driver":"fuse-overlayfs","bridge":"none"}' \
      | sudo tee /etc/docker/daemon.json >/dev/null
  fi
  sudo bash -c 'nohup dockerd >/var/log/dockerd.log 2>&1 &'
  for _ in $(seq 1 45); do
    if sudo docker info >/dev/null 2>&1; then
      echo "==> dockerd is ready"
      return 0
    fi
    sleep 1
  done
  echo "!! dockerd failed to start" >&2
  sudo tail -n 30 /var/log/dockerd.log >&2 || true
  return 1
}

# ensure_container <name> <docker run args...>
# Starts the container if it exists (stopped), otherwise creates it. Idempotent.
ensure_container() {
  local name="$1"; shift
  if [ "$(sudo docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = "true" ]; then
    echo "==> $name already running"
    return 0
  fi
  if sudo docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
    echo "==> Starting existing container $name"
    sudo docker start "$name" >/dev/null
  else
    echo "==> Creating container $name"
    sudo docker run -d --name "$name" --restart unless-stopped "$@" >/dev/null
  fi
}
