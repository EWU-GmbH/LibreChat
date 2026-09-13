#!/usr/bin/env bash
# Cloud Agent install phase: durable, idempotent repository setup.
# Installs MongoDB, generates local config, installs deps, and builds the app.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# 1. MongoDB (system dependency) — install only when missing.
if ! command -v mongod >/dev/null 2>&1; then
  echo "==> Installing MongoDB 8.0"
  sudo apt-get update
  sudo apt-get install -y gnupg curl
  curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
    | sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor --yes
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
    | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
  sudo apt-get update
  sudo apt-get install -y mongodb-org
else
  echo "==> MongoDB already installed: $(mongod --version | head -1)"
fi

# 2. Local environment file — derive from the tracked example when absent.
if [ ! -f .env ]; then
  echo "==> Creating .env from .env.example"
  cp .env.example .env
  # Bind to all interfaces so the app is reachable from the host/browser.
  sed -i 's|^HOST=localhost|HOST=0.0.0.0|' .env
  # Meilisearch is not part of this environment; disable message search.
  sed -i 's|^SEARCH=true|SEARCH=false|' .env
fi

# 3. librechat.yaml — enable a working AI endpoint. API keys are read from
#    environment secrets at runtime (no secrets are written to this file).
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

# 4. Node dependencies (npm workspaces).
echo "==> Installing npm dependencies"
npm ci

# 5. Build workspace packages (data-provider, data-schemas, api) and the client.
echo "==> Building packages and client"
npm run frontend

echo "==> Install phase complete"
