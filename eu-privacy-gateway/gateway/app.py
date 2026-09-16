"""OpenAI-compatible EU privacy gateway.

Sits between LibreChat and the model provider. Before a request leaves for the
external model, German PII is replaced with stable, reversible placeholders.
The model's response (streamed or not) is de-anonymized locally so the user
sees the real values while the provider only ever saw placeholders.

Upstream provider is chosen from the environment:
  - OpenRouter (``OPENROUTER_KEY`` / ``OPENROUTER_API_KEY``) if present, using
    the auto-router and privacy-routing params, else
  - Mistral direct (``MISTRAL_API_KEY``) as a fallback for the PoC.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .pii import Pseudonymizer, StreamRestorer, get_analyzer

# Verbose audit logging prints RAW PII and the placeholder->value mapping. It is
# a DEV-ONLY affordance for demonstrating masking and MUST stay off in
# production. Default off (production-safe); opt in with GATEWAY_VERBOSE_AUDIT=1.
VERBOSE_AUDIT = os.environ.get("GATEWAY_VERBOSE_AUDIT", "0").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

# Only stdout by default (captured by the platform's log pipeline). A file sink
# is attached ONLY when GATEWAY_AUDIT_LOG is explicitly set, so production does
# not silently persist anything to disk.
_log_handlers: List[logging.Handler] = [logging.StreamHandler()]
_audit_log_path = os.environ.get("GATEWAY_AUDIT_LOG")
if _audit_log_path:
    _log_handlers.append(logging.FileHandler(_audit_log_path))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=_log_handlers,
)
log = logging.getLogger("eu-privacy-gateway")


def _upstream_config() -> Dict[str, Any]:
    openrouter_key = os.environ.get("OPENROUTER_KEY") or os.environ.get("OPENROUTER_API_KEY")
    if openrouter_key:
        return {
            "provider": "openrouter",
            "base_url": os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
            "api_key": openrouter_key,
            "default_model": os.environ.get("GATEWAY_DEFAULT_MODEL", "openrouter/auto"),
            # Privacy routing: forbid providers that train on / retain data.
            "extra_body": {"provider": {"data_collection": "deny", "zdr": True}},
        }
    return {
        "provider": "mistral",
        "base_url": os.environ.get("MISTRAL_BASE_URL", "https://api.mistral.ai/v1"),
        "api_key": os.environ.get("MISTRAL_API_KEY", ""),
        "default_model": os.environ.get("GATEWAY_DEFAULT_MODEL", "mistral-small-latest"),
        "extra_body": {},
    }


UPSTREAM = _upstream_config()
app = FastAPI(title="EU Privacy Gateway", version="0.1.0")


@app.on_event("startup")
def _startup() -> None:
    log.info("Loading Presidio analyzer (spaCy de_core_news_lg) ...")
    get_analyzer()
    log.info(
        "Gateway ready. Upstream provider=%s base_url=%s default_model=%s verbose_audit=%s",
        UPSTREAM["provider"],
        UPSTREAM["base_url"],
        UPSTREAM["default_model"],
        VERBOSE_AUDIT,
    )
    if VERBOSE_AUDIT:
        log.warning(
            "GATEWAY_VERBOSE_AUDIT is ON: raw PII and the placeholder mapping "
            "will be logged. This is a DEV-ONLY setting; do NOT enable it in "
            "production."
        )
    if UPSTREAM["provider"] == "mistral":
        log.warning(
            "No OPENROUTER_KEY found -> using Mistral fallback. Add OPENROUTER_KEY "
            "as a secret to enable OpenRouter auto-routing + privacy routing."
        )


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"status": "ok", "provider": UPSTREAM["provider"]}


@app.get("/v1/models")
def models() -> Dict[str, Any]:
    now = int(time.time())
    # Model routing is pass-through: the concrete selectable model IDs are
    # curated in LibreChat's config. Advertise only the default (auto) here.
    ids = [UPSTREAM["default_model"]]
    return {"object": "list", "data": [{"id": m, "object": "model", "created": now, "owned_by": "eu-privacy-gateway"} for m in ids]}


def _mask_messages(messages: List[Dict[str, Any]], pseudo: Pseudonymizer) -> List[Dict[str, Any]]:
    masked: List[Dict[str, Any]] = []
    for msg in messages:
        new_msg = dict(msg)
        content = msg.get("content")
        if isinstance(content, str):
            new_msg["content"] = pseudo.mask(content)
        elif isinstance(content, list):
            new_parts = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str):
                    new_part = dict(part)
                    new_part["text"] = pseudo.mask(part["text"])
                    new_parts.append(new_part)
                else:
                    new_parts.append(part)
            new_msg["content"] = new_parts
        masked.append(new_msg)
    return masked


def _log_mask_summary(original: List[Dict[str, Any]], masked: List[Dict[str, Any]], pseudo: Pseudonymizer) -> None:
    """Audit the masking step.

    In production (VERBOSE_AUDIT off) only aggregate, non-sensitive information
    is logged: how many entities were masked and their entity types/counts.
    Raw PII and the placeholder->value mapping are NEVER logged unless the
    dev-only GATEWAY_VERBOSE_AUDIT flag is set.
    """
    counts = pseudo.entity_type_counts()
    total = sum(counts.values())
    log.info(
        "Masked %d PII entit%s across %d message(s); by type: %s",
        total,
        "y" if total == 1 else "ies",
        len(original),
        counts or "{}",
    )
    if not VERBOSE_AUDIT:
        return
    log.info("=== INBOUND (from LibreChat, RAW) ===")
    for m in original:
        if isinstance(m.get("content"), str):
            log.info("  [%s] %s", m.get("role"), m["content"])
    log.info("=== OUTBOUND (to provider, MASKED) ===")
    for m in masked:
        if isinstance(m.get("content"), str):
            log.info("  [%s] %s", m.get("role"), m["content"])
    log.info("=== PII MAPPING (kept locally, %d entities) ===", len(pseudo.mapping_summary()))
    for placeholder, value in pseudo.mapping_summary().items():
        log.info("  %s -> %s", placeholder, value)


# Model names that mean "let the gateway/OpenRouter pick": these are resolved to
# the configured default (``openrouter/auto``). Any other value is a concrete
# provider model ID and is forwarded to the upstream unchanged (pass-through).
_AUTO_MODEL_ALIASES = {"", "auto", "openrouter/auto", "default"}


def _resolve_model(requested: Optional[str]) -> str:
    """Pass-through model routing.

    - No model, or a friendly/auto alias -> the configured default
      (``openrouter/auto``), letting OpenRouter auto-select a provider.
    - A concrete model ID (e.g. ``anthropic/claude-3.7-sonnet``) -> forwarded
      unchanged so users can pick a specific model.
    """
    if requested is None:
        return UPSTREAM["default_model"]
    if requested.strip().lower() in _AUTO_MODEL_ALIASES:
        return UPSTREAM["default_model"]
    return requested


def _build_upstream_payload(body: Dict[str, Any], masked_messages: List[Dict[str, Any]]) -> Dict[str, Any]:
    payload = dict(body)
    payload["messages"] = masked_messages
    payload["model"] = _resolve_model(payload.get("model"))
    for key, value in UPSTREAM["extra_body"].items():
        payload.setdefault(key, value)
    return payload


def _headers() -> Dict[str, str]:
    headers = {"Authorization": f"Bearer {UPSTREAM['api_key']}", "Content-Type": "application/json"}
    if UPSTREAM["provider"] == "openrouter":
        headers["HTTP-Referer"] = "https://librechat.local"
        headers["X-Title"] = "EU Privacy Gateway"
    return headers


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> Any:
    body = await request.json()
    messages: List[Dict[str, Any]] = body.get("messages", [])
    stream: bool = bool(body.get("stream", False))

    pseudo = Pseudonymizer(get_analyzer())
    masked_messages = _mask_messages(messages, pseudo)
    _log_mask_summary(messages, masked_messages, pseudo)

    payload = _build_upstream_payload(body, masked_messages)
    url = f"{UPSTREAM['base_url'].rstrip('/')}/chat/completions"

    if stream:
        return StreamingResponse(
            _stream_upstream(url, payload, pseudo),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
        )
    return await _complete_upstream(url, payload, pseudo)


async def _complete_upstream(url: str, payload: Dict[str, Any], pseudo: Pseudonymizer) -> Any:
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, json=payload, headers=_headers())
    if resp.status_code >= 400:
        log.error("Upstream error %s: %s", resp.status_code, resp.text[:500])
        return JSONResponse(status_code=resp.status_code, content=_safe_json(resp.text))

    data = resp.json()
    for choice in data.get("choices", []):
        message = choice.get("message", {})
        if isinstance(message.get("content"), str):
            message["content"] = pseudo.restore(message["content"])
    if VERBOSE_AUDIT:
        log.info("=== RESPONSE (restored, non-stream) ===")
        for choice in data.get("choices", []):
            log.info("  %s", choice.get("message", {}).get("content", ""))
    return JSONResponse(content=data)


async def _stream_upstream(url: str, payload: Dict[str, Any], pseudo: Pseudonymizer) -> AsyncGenerator[bytes, None]:
    restorer = StreamRestorer(pseudo)
    restored_full: List[str] = []
    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream("POST", url, json=payload, headers=_headers()) as resp:
            if resp.status_code >= 400:
                text = (await resp.aread()).decode("utf-8", "replace")
                log.error("Upstream stream error %s: %s", resp.status_code, text[:500])
                yield f"data: {json.dumps(_safe_json(text))}\n\n".encode()
                yield b"data: [DONE]\n\n"
                return
            async for line in resp.aiter_lines():
                if not line:
                    continue
                if not line.startswith("data:"):
                    continue
                data_str = line[len("data:"):].strip()
                if data_str == "[DONE]":
                    tail = restorer.flush()
                    if tail:
                        restored_full.append(tail)
                        yield _sse_delta(tail)
                    yield b"data: [DONE]\n\n"
                    break
                chunk = _try_json(data_str)
                if chunk is None:
                    continue
                emitted = _restore_stream_chunk(chunk, restorer)
                if emitted:
                    restored_full.append(emitted)
                yield f"data: {json.dumps(chunk)}\n\n".encode()
    if VERBOSE_AUDIT:
        log.info("=== RESPONSE (restored, streamed) ===")
        log.info("  %s", "".join(restored_full))


def _restore_stream_chunk(chunk: Dict[str, Any], restorer: StreamRestorer) -> str:
    emitted = ""
    for choice in chunk.get("choices", []):
        delta = choice.get("delta", {})
        if isinstance(delta.get("content"), str) and delta["content"]:
            restored = restorer.push(delta["content"])
            delta["content"] = restored
            emitted += restored
    return emitted


def _sse_delta(content: str) -> bytes:
    chunk = {
        "id": "chatcmpl-gateway-flush",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": None}],
    }
    return f"data: {json.dumps(chunk)}\n\n".encode()


def _try_json(s: str) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return None


def _safe_json(text: str) -> Dict[str, Any]:
    parsed = _try_json(text)
    if isinstance(parsed, dict):
        return parsed
    return {"error": {"message": text[:500], "type": "upstream_error"}}
