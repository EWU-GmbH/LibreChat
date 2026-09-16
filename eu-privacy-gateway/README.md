# EU Privacy Gateway

An OpenAI-compatible reverse proxy that sits between **LibreChat** and the model
provider. It provides two things:

1. **Reversible PII pseudonymization** — German personal data (names,
   addresses, IBAN, customer/case numbers, tax/health/social identifiers, KFZ)
   is detected with **Microsoft Presidio** (spaCy `de_core_news_lg` + German
   regex recognizers) and replaced with **stable placeholders**
   (`[PERSON_1]`, `[IBAN_1]`, ...) **before** the text leaves for the external
   model. The mapping is kept locally and used to **restore** the real values in
   the model's response — including **streamed** responses (placeholders split
   across SSE chunks are stitched back together before substitution).
2. **Multi-model + auto model selection** — via **OpenRouter** (`openrouter/auto`
   + privacy routing) when an OpenRouter key is present, otherwise a **Mistral**
   fallback so the masking mechanism can still be demonstrated.

It is intentionally a thin custom proxy (rather than LiteLLM's Presidio
guardrail) so we have full control of streaming/tool-call restore.

## Model routing (pass-through)

Model selection is **pass-through**. If LibreChat sends no model, or a
friendly/auto alias (`auto`, `openrouter/auto`, `default`), the gateway uses
`openrouter/auto` and lets OpenRouter pick a provider. Any other value is a
concrete OpenRouter model ID (e.g. `anthropic/claude-3.7-sonnet`) and is
forwarded unchanged, so users can also pick a specific model. Privacy routing
(`provider: { data_collection: "deny", zdr: true }`) is injected on every
request.

## Audit logging (production-safe)

By default the gateway logs only **aggregate, non-sensitive** audit info: how
many entities were masked and their entity types/counts — never raw PII or the
placeholder→value mapping. Verbose masking/restore logging (raw PII + mapping)
is a **dev-only** affordance behind `GATEWAY_VERBOSE_AUDIT=1`; it must stay off
in production. A file log sink is attached only when `GATEWAY_AUDIT_LOG` is set;
otherwise logs go to stdout only.

## Container

`Dockerfile` builds a CPU-only image that bakes in the spaCy `de_core_news_lg`
model and (when enabled) the GLiNER weights, so first boot is fast. It runs
`uvicorn gateway.app:app --host 0.0.0.0 --port $PORT`. GLiNER can be disabled
with `GATEWAY_USE_GLINER=0` (falls back to spaCy + regex, lower name recall).

## Architecture

```
LibreChat (custom "Mistral" endpoint, baseURL -> gateway)
      │  POST /v1/chat/completions  (real PII)
      ▼
EU Privacy Gateway  ──►  Presidio analyze + mask (stable placeholders)
      │  POST /chat/completions  (PLACEHOLDERS ONLY)
      ▼
OpenRouter (openrouter/auto, provider={data_collection:deny, zdr:true})
   or Mistral (fallback)
      │  response with placeholders
      ▼
Gateway restore (stream-aware)  ──►  real values
      ▲
LibreChat renders + stores the restored answer
```

## Files

- `gateway/pii.py` — Presidio engine, German recognizers, `Pseudonymizer`
  (stable, reversible mapping) and `StreamRestorer` (stream stitching).
- `gateway/app.py` — FastAPI OpenAI-compatible endpoints
  (`/v1/chat/completions`, `/v1/models`, `/health`), upstream selection and
  audit logging.
- `tests/test_pii.py` — mask/restore roundtrip + stream-stitching smoke tests.
- `requirements.txt`, `run.sh`.

**No secrets are stored here.** Upstream API keys are read from the environment.

## Run (dev)

```bash
cd eu-privacy-gateway
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m spacy download de_core_news_lg
# Upstream key comes from the environment (never commit it):
#   OPENROUTER_KEY=...   (preferred)  or  MISTRAL_API_KEY=...  (fallback)
bash run.sh                 # serves on http://127.0.0.1:8100
```

Point the LibreChat custom endpoint at it (dev `librechat.yaml`, gitignored):

```yaml
endpoints:
  custom:
    - name: 'Mistral'
      apiKey: '${MISTRAL_API_KEY}'      # ignored by the gateway; it uses its own env key
      baseURL: 'http://localhost:8100/v1'
```

Then restart the dev backend: `unset OPENAI_API_KEY; npm run backend:dev`.

## Upstream selection

- If `OPENROUTER_KEY` / `OPENROUTER_API_KEY` is set: base
  `https://openrouter.ai/api/v1`, default model `openrouter/auto`, and privacy
  routing `provider: { data_collection: "deny", zdr: true }` is injected.
- Otherwise: Mistral direct (`https://api.mistral.ai/v1`,
  `mistral-small-latest`). This PoC ran on the **Mistral fallback** because no
  OpenRouter key was present in the environment.

## Detected German entities

`PERSON`, `LOCATION`, `IBAN`, `EMAIL`, `PHONE`, `CREDIT_CARD`, plus custom:
`ADDRESS` (street + number), `PLZ` (postal code, context-gated),
`KUNDENNUMMER` (customer no.), `AKTENZEICHEN` (case no.), `STEUERID` (tax id),
`KVNUMMER` (health insurance), `RVNUMMER` (social/pension insurance), `KFZ`
(license plate).

## Known limitations (PoC)

- **Detection recall** on free German text is imperfect. City tokens like
  "Essen" (also the verb "to eat") are sometimes missed by spaCy NER; house
  numbers can be dropped when an NER span outranks the address regex. Regex
  recognizers for IDs are context-gated to limit false positives, which can
  miss unlabeled IDs. Production should tune thresholds and add GLiNER
  (`urchade/gliner_multi_pii-v1`) as an additional recognizer for higher recall.
- **Streaming stitching** buffers from the last unmatched `[` onward. This is
  robust for `[LABEL_n]` placeholders but assumes the model echoes placeholders
  verbatim. A model that rewrites a placeholder (e.g. translates the bracket
  text) would not be restored.
- **Tool calls / JSON**: only message text content is masked/restored today.
  `tool_calls` arguments and structured JSON outputs are not yet traversed.
- **Mapping scope** is per-request (rebuilt from the full message list each
  call), which keeps placeholders stable within a conversation turn. A shared,
  persisted mapping store would be needed for cross-turn stability under load.

## Productionization plan

1. **Deploy the gateway as an EU-region service** (e.g. Railway, region
   `europe-west4`) as a container running `uvicorn gateway.app:app`. Keep it in
   the same EU region/VPC as LibreChat so PII never leaves the EU unencrypted.
   Pin the spaCy model in the image build.
2. **Point production LibreChat** at it: set the custom endpoint `baseURL` to the
   gateway's internal URL (e.g. `http://eu-privacy-gateway.railway.internal/v1`)
   so masking is mandatory and the gateway is not publicly exposed.
3. **Wire OpenRouter**: add secret `OPENROUTER_KEY` to the gateway service.
   The gateway then uses `openrouter/auto` and injects
   `provider: { data_collection: "deny", zdr: true }` so only zero-data-retention
   providers are used. Optionally restrict `provider.order` / `allow_fallbacks`.
4. **Secrets**: `OPENROUTER_KEY` (required for OpenRouter). No provider key is
   ever written to `librechat.yaml` or this repo. The gateway holds the only
   upstream credential.
5. **Residual-risk notes**:
   - Anything the detector misses is sent in the clear to the provider —
     treat detection as best-effort defense-in-depth, not a guarantee. Add
     GLiNER + tuned thresholds and a human-review/allowlist path for high-risk
     flows.
   - The local placeholder→value mapping is sensitive; keep it in memory only
     (never log real values in production — the verbose audit logging here is a
     PoC affordance and must be disabled/redacted in prod).
   - Tool-call arguments, file uploads, and image OCR text are not yet covered.
   - OpenRouter ZDR depends on the selected upstream honoring it; verify the
     effective provider per request and restrict the provider allowlist.
```
