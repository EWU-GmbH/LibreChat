#!/usr/bin/env bash
# Cloud Agent start phase: per-boot runtime initialization.
# Brings up Docker and the backing services (MongoDB, Meilisearch, pgvector,
# RAG API), then waits for readiness and returns.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=/dev/null
source "$REPO_ROOT/.cursor/setup/stack.env"
# shellcheck source=/dev/null
source "$REPO_ROOT/.cursor/setup/docker-lib.sh"

ensure_dockerd

# The install phase builds node_modules, the client bundle, and generates
# .env / librechat.yaml. Those are untracked, so a boot-time git checkout
# (default_checkout) can discard them even when booting from a prebuilt
# environment. Rebuild them here if they are missing so the app is runnable.
if [ ! -d node_modules ] || [ ! -f client/dist/index.html ] || [ ! -f .env ]; then
  echo "==> App artifacts missing after checkout; rebuilding"
  bash "$REPO_ROOT/.cursor/setup/build-app.sh"
fi

# MongoDB
ensure_container mongodb --network host \
  -v mongo_data:/data/db \
  "$MONGO_IMAGE" --noauth

# Meilisearch (message search)
ensure_container meilisearch --network host \
  -e MEILI_NO_ANALYTICS=true \
  -e MEILI_MASTER_KEY="$MEILI_MASTER_KEY" \
  -v meili_data:/meili_data \
  "$MEILI_IMAGE"

# pgvector (vector store for RAG)
ensure_container vectordb --network host \
  -e POSTGRES_DB="$PG_DB" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -v pgdata:/var/lib/postgresql/data \
  "$VECTORDB_IMAGE"

# Wait for Postgres, then ensure the pgvector extension exists.
for _ in $(seq 1 30); do
  if sudo docker exec vectordb pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
sudo docker exec vectordb psql -U "$PG_USER" -d "$PG_DB" \
  -c 'CREATE EXTENSION IF NOT EXISTS vector;' >/dev/null 2>&1 || true

# RAG API (file ingestion + retrieval with local HuggingFace embeddings)
ensure_container rag_api --network host \
  -e DB_HOST=localhost -e DB_PORT=5432 \
  -e POSTGRES_DB="$PG_DB" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e RAG_PORT="$RAG_PORT" \
  -e EMBEDDINGS_PROVIDER="$RAG_EMBEDDINGS_PROVIDER" \
  -e EMBEDDINGS_MODEL="$RAG_EMBEDDINGS_MODEL" \
  -v hf_cache:/root/.cache/huggingface \
  "$RAG_IMAGE"

# Readiness checks.
ok=1
for _ in $(seq 1 30); do
  sudo docker exec mongodb mongosh --quiet --eval 'db.runCommand({ping:1})' >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:7700/health >/dev/null 2>&1 || ok=0
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1 || ok=0

sudo docker ps --format '  {{.Names}}\t{{.Status}}'
if [ "$ok" = "1" ]; then
  echo "==> Backing services are ready"
else
  echo "!! One or more backing services did not become ready" >&2
fi
