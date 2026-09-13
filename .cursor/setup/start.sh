#!/usr/bin/env bash
# Cloud Agent start phase: per-boot runtime initialization.
# Ensures MongoDB is running and ready, then returns.
set -euo pipefail

DBPATH="${MONGO_DBPATH:-/data/db}"
LOGPATH="${MONGO_LOGPATH:-/tmp/mongod.log}"

sudo mkdir -p "$DBPATH"
sudo chown -R "$(id -u):$(id -g)" "$DBPATH"

if pgrep -x mongod >/dev/null 2>&1; then
  echo "==> MongoDB already running"
else
  echo "==> Starting MongoDB (dbpath=$DBPATH)"
  mongod --dbpath "$DBPATH" --bind_ip 127.0.0.1 --port 27017 \
    --fork --logpath "$LOGPATH"
fi

# Wait for MongoDB to accept connections.
for _ in $(seq 1 30); do
  if mongosh --quiet --eval 'db.runCommand({ ping: 1 })' >/dev/null 2>&1; then
    echo "==> MongoDB is ready"
    exit 0
  fi
  sleep 1
done

echo "!! MongoDB did not become ready in time" >&2
tail -n 20 "$LOGPATH" >&2 || true
exit 1
