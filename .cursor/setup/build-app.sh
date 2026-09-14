#!/usr/bin/env bash
# Builds the LibreChat Node app: generates local config, installs npm
# dependencies, and builds the workspace packages + client.
# Safe to call from install (always) and from start (only when the boot-time
# git checkout discarded the previously-built, untracked artifacts).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=/dev/null
source "$REPO_ROOT/.cursor/setup/stack.env"

# Local environment file — derive from the tracked example when absent.
if [ ! -f .env ]; then
  echo "==> Creating .env from .env.example"
  cp .env.example .env
  sed -i 's|^HOST=localhost|HOST=0.0.0.0|' .env
  sed -i 's|^SEARCH=false|SEARCH=true|' .env
  sed -i 's|^MEILI_HOST=.*|MEILI_HOST=http://127.0.0.1:7700|' .env
  grep -q '^RAG_PORT=' .env || echo "RAG_PORT=${RAG_PORT}" >> .env
  grep -q '^RAG_API_URL=' .env || echo 'RAG_API_URL=http://127.0.0.1:8000' >> .env
fi

# librechat.yaml — enable a working AI endpoint. API keys are read from
# environment secrets at runtime (no secrets are written to this file).
if [ ! -f librechat.yaml ]; then
  echo "==> Creating librechat.yaml"
  cat > librechat.yaml <<'YAML'
version: 1.2.6

interface:
  endpointsMenu: true
  modelSelect: true
  parameters: true
  sidePanel: true
  presets: true
  prompts: true
  bookmarks: true
  multiConvo: true
  agents: true

endpoints:
  custom:
    - name: 'Mistral'
      apiKey: '${MISTRAL_API_KEY}'
      baseURL: 'https://api.mistral.ai/v1'
      models:
        default:
          - 'mistral-small-latest'
          - 'mistral-large-latest'
        fetch: false
      titleConvo: true
      titleModel: 'mistral-small-latest'
      modelDisplayLabel: 'Mistral'
      dropParams: ['stop', 'user', 'frequency_penalty', 'presence_penalty']
YAML
fi

# Node dependencies (npm workspaces).
echo "==> Installing npm dependencies"
npm ci

# Build workspace packages (data-provider, data-schemas, api) and the client.
echo "==> Building packages and client"
npm run frontend
