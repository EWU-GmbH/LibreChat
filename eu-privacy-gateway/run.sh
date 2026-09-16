#!/usr/bin/env bash
# Start the EU privacy gateway (dev). Reads upstream keys from the environment;
# never hard-code secrets here.
set -euo pipefail
cd "$(dirname "$0")"
source .venv/bin/activate
export GATEWAY_AUDIT_LOG="${GATEWAY_AUDIT_LOG:-/tmp/gateway-audit.log}"
exec uvicorn gateway.app:app --host 127.0.0.1 --port "${GATEWAY_PORT:-8100}" --log-level info
