# EU Privacy Gateway — OpenAI-compatible PII-masking proxy.
#
# The image bakes in the heavy NLP assets so the first request is fast:
#   - spaCy German model (de_core_news_lg)
#   - GLiNER weights (urchade/gliner_multi_pii-v1) when GLiNER is enabled
#
# torch is installed from the CPU-only wheel index to keep the image small and
# avoid pulling CUDA. GLiNER can be disabled at runtime with GATEWAY_USE_GLINER=0
# (the gateway then falls back to spaCy + regex, with lower name recall).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    # Bake the HuggingFace cache into the image so GLiNER weights ship with it.
    HF_HOME=/opt/hf \
    # Prod-safe defaults: no raw-PII audit logging, GLiNER on.
    GATEWAY_VERBOSE_AUDIT=0 \
    GATEWAY_USE_GLINER=1

WORKDIR /app

# Minimal build tooling for any packages without prebuilt wheels (e.g.
# sentencepiece on some platforms). Kept in a single layer and removed after.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./

# Install CPU-only torch first so the resolver does not pull the CUDA build when
# it later satisfies torch==2.14.0 from requirements.txt.
RUN pip install --upgrade pip \
    && pip install "torch==2.14.0" --index-url https://download.pytorch.org/whl/cpu \
    && pip install -r requirements.txt

# Pre-download the spaCy German model.
RUN python -m spacy download de_core_news_lg

# Pre-download the GLiNER weights into the baked HF cache (best-effort: if this
# fails the image still runs and fetches weights on first boot, or falls back to
# spaCy+regex when GATEWAY_USE_GLINER=0).
ARG GLINER_MODEL=urchade/gliner_multi_pii-v1
RUN python -c "from gliner import GLiNER; GLiNER.from_pretrained('${GLINER_MODEL}')" \
    || echo 'WARN: GLiNER prefetch failed; will fetch at runtime or fall back to spaCy+regex'

COPY gateway ./gateway

# Railway injects PORT at runtime; default to 8100 for local runs. The launcher
# binds a dual-stack IPv6 socket (V6ONLY disabled) so the service is reachable
# over Railway's IPv6-only private network via its *.railway.internal hostname
# while still accepting the IPv4 healthcheck.
EXPOSE 8100
CMD ["python", "-m", "gateway.serve"]
