"""German PII detection + reversible pseudonymization for the EU privacy gateway.

Uses Microsoft Presidio (spaCy ``de_core_news_lg``) for NER plus a set of
regex recognizers for German-specific identifiers. Masking assigns *stable*
placeholders (``[PERSON_1]``, ``[IBAN_1]`` ...) so the same value always maps to
the same placeholder within a conversation, and the mapping is reversible so the
model's response can be de-anonymized locally.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Dict, List, Optional, Tuple

from presidio_analyzer import (
    AnalyzerEngine,
    EntityRecognizer,
    Pattern,
    PatternRecognizer,
    RecognizerResult,
)
from presidio_analyzer.nlp_engine import NlpEngineProvider

log = logging.getLogger("eu-privacy-gateway.pii")

# Presidio entity type -> short, model-friendly placeholder label.
ENTITY_LABELS: Dict[str, str] = {
    "PERSON": "PERSON",
    "LOCATION": "LOCATION",
    "IBAN_CODE": "IBAN",
    "EMAIL_ADDRESS": "EMAIL",
    "PHONE_NUMBER": "PHONE",
    "CREDIT_CARD": "CREDIT_CARD",
    "DE_ADDRESS": "ADDRESS",
    "DE_POSTAL_CODE": "PLZ",
    "DE_CUSTOMER_ID": "KUNDENNUMMER",
    "DE_CASE_ID": "AKTENZEICHEN",
    "DE_TAX_ID": "STEUERID",
    "DE_HEALTH_INSURANCE_ID": "KVNUMMER",
    "DE_SOCIAL_INSURANCE_ID": "RVNUMMER",
    "DE_LICENSE_PLATE": "KFZ",
}

DEFAULT_SCORE_THRESHOLD = 0.35

# --- GLiNER (high-recall NER) configuration -------------------------------
# EWU has confirmed there is NO health data, and an occasional missed CITY is
# acceptable, so the gateway is tuned for high recall on PERSON NAMES and STREET
# ADDRESSES. GLiNER (a zero-shot span model) complements spaCy, which alone
# misses names such as "Dr. Müller".
GLINER_ENABLED = os.environ.get("GATEWAY_USE_GLINER", "1").lower() not in {"0", "false", "no"}
GLINER_MODEL = os.environ.get("GLINER_MODEL", "urchade/gliner_multi_pii-v1")
# Recall-oriented detection threshold for GLiNER itself.
GLINER_THRESHOLD = float(os.environ.get("GLINER_THRESHOLD", "0.30"))
# GLiNER prompt labels -> Presidio entity types. Focused on names + addresses;
# ``organization`` is intentionally omitted (it mislabels pronouns like "Wir"
# and adds noise without helping the name/address recall goal).
GLINER_LABEL_MAP: Dict[str, str] = {
    "person": "PERSON",
    "name": "PERSON",
    "address": "DE_ADDRESS",
}


def _build_analyzer() -> AnalyzerEngine:
    provider = NlpEngineProvider(
        nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "de", "model_name": "de_core_news_lg"}],
        }
    )
    nlp_engine = provider.create_engine()
    analyzer = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=["de"])

    for recognizer in _german_recognizers():
        analyzer.registry.add_recognizer(recognizer)

    if GLINER_ENABLED:
        gliner = _try_build_gliner_recognizer()
        if gliner is not None:
            analyzer.registry.add_recognizer(gliner)
            log.info("GLiNER recognizer registered (model=%s, threshold=%s)", GLINER_MODEL, GLINER_THRESHOLD)

    return analyzer


def _try_build_gliner_recognizer() -> Optional["GLiNERRecognizer"]:
    """Build the GLiNER recognizer, degrading gracefully if it is unavailable.

    If GLiNER/torch cannot be imported or the model cannot be loaded, the
    gateway falls back to spaCy + regex so masking still works (with lower
    name recall).
    """
    try:
        recognizer = GLiNERRecognizer(
            model_name=GLINER_MODEL,
            label_map=GLINER_LABEL_MAP,
            threshold=GLINER_THRESHOLD,
        )
        recognizer.load()
        return recognizer
    except Exception as exc:  # noqa: BLE001 - PoC fallback: never break masking.
        log.warning(
            "GLiNER unavailable (%s); falling back to spaCy + regex only. "
            "Name recall will be lower.",
            exc,
        )
        return None


class GLiNERRecognizer(EntityRecognizer):
    """High-recall NER via the GLiNER span model, wrapped as a Presidio recognizer.

    GLiNER (``urchade/gliner_multi_pii-v1``) is a zero-shot model prompted with
    plain-language labels (``person``, ``name``, ``address`` ...). It reliably
    catches German names that spaCy misses (e.g. "Dr. Müller"). Detected spans
    are returned with a recall-biased score floor so they survive the analyzer
    threshold and get masked.
    """

    _SCORE_FLOOR = 0.6

    def __init__(
        self,
        model_name: str,
        label_map: Dict[str, str],
        supported_language: str = "de",
        threshold: float = 0.30,
    ) -> None:
        self._model_name = model_name
        self._label_map = label_map
        self._threshold = threshold
        self._prompt_labels = sorted(set(label_map.keys()))
        self._model = None
        super().__init__(
            supported_entities=sorted(set(label_map.values())),
            supported_language=supported_language,
            name="GLiNERRecognizer",
        )

    def load(self) -> None:
        if self._model is not None:
            return
        from gliner import GLiNER  # imported lazily so the dep stays optional

        self._model = GLiNER.from_pretrained(self._model_name)

    def analyze(self, text, entities, nlp_artifacts=None) -> List[RecognizerResult]:
        if not text or not text.strip():
            return []
        if self._model is None:
            self.load()

        try:
            predictions = self._model.predict_entities(
                text, self._prompt_labels, threshold=self._threshold
            )
        except Exception as exc:  # noqa: BLE001 - degrade to spaCy + regex.
            log.warning("GLiNER inference failed (%s); skipping GLiNER for this text.", exc)
            return []

        results: List[RecognizerResult] = []
        for pred in predictions:
            entity_type = self._label_map.get(pred["label"])
            if entity_type is None:
                continue
            if entities and entity_type not in entities:
                continue
            # Recall bias: floor the score so borderline names still get masked.
            score = max(float(pred["score"]), self._SCORE_FLOOR)
            results.append(
                RecognizerResult(
                    entity_type=entity_type,
                    start=int(pred["start"]),
                    end=int(pred["end"]),
                    score=score,
                )
            )
        return results


def _german_recognizers() -> List[PatternRecognizer]:
    return [
        # German IBAN (also matches spaced groups). High confidence.
        PatternRecognizer(
            supported_entity="IBAN_CODE",
            supported_language="de",
            patterns=[
                Pattern(
                    "de_iban",
                    r"\bDE\d{2}[ ]?(?:\d{4}[ ]?){4}\d{2}\b",
                    0.95,
                )
            ],
        ),
        # Street address (recall-biased): "Musterstraße 12", "Bahnhofstr. 5a",
        # "Lindenweg 3a", "Hauptstr. 45", "Berliner Allee 12-14", "Rheinufer 7".
        # A missed city is acceptable; a missed street is not, so this matches
        # both compound street names (suffix glued on) and separated ones
        # ("<Word> Allee/Platz/..."), each followed by a house number that may
        # carry a letter ("12a") or be a range ("12-14").
        PatternRecognizer(
            supported_entity="DE_ADDRESS",
            supported_language="de",
            patterns=[
                # Compound suffix, e.g. Musterstraße / Bahnhofstr. / Lindenweg.
                Pattern(
                    "de_street_compound",
                    r"\b[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]*"
                    r"(?:stra(?:ß|ss)e|str\.?|weg|platz|pl\.|allee|ring|gasse|damm|ufer|höfe?|hof|steig|wall|markt)"
                    r"\s+\d{1,4}(?:\s?[-/]\s?\d{1,4})?\s?[a-zA-Z]?\b",
                    0.85,
                ),
                # Separated suffix as its own word, e.g. "Berliner Allee 12-14".
                Pattern(
                    "de_street_separated",
                    r"\b[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+\s+"
                    r"(?:Stra(?:ß|ss)e|Str\.?|Weg|Platz|Pl\.|Allee|Ring|Gasse|Damm|Ufer|Steig|Markt)"
                    r"\s+\d{1,4}(?:\s?[-/]\s?\d{1,4})?\s?[a-zA-Z]?\b",
                    0.85,
                ),
            ],
        ),
        # 5-digit postal code, only near address context to limit false positives.
        PatternRecognizer(
            supported_entity="DE_POSTAL_CODE",
            supported_language="de",
            patterns=[Pattern("de_plz", r"\b\d{5}\b", 0.3)],
            context=["plz", "postleitzahl", "wohnhaft", "straße", "strasse", "ort"],
        ),
        # Customer number, e.g. "4711-8890" / "KDN 100245".
        PatternRecognizer(
            supported_entity="DE_CUSTOMER_ID",
            supported_language="de",
            patterns=[
                Pattern("de_kundennr_dash", r"\b\d{3,6}-\d{3,6}\b", 0.55),
                Pattern("de_kundennr_ctx", r"\b\d{5,10}\b", 0.3),
            ],
            context=["kundennummer", "kundennr", "kdn", "kunden-nr", "kundenkonto"],
        ),
        # Case / file reference (Aktenzeichen), e.g. "AZ 12 C 345/24".
        PatternRecognizer(
            supported_entity="DE_CASE_ID",
            supported_language="de",
            patterns=[
                Pattern("de_az", r"\b\d{1,3}\s?[A-Z]{1,3}\s?\d{1,4}/\d{2,4}\b", 0.6),
            ],
            context=["aktenzeichen", "az", "geschäftszeichen", "fallnummer", "vorgang"],
        ),
        # Steuer-Identifikationsnummer: 11 digits.
        PatternRecognizer(
            supported_entity="DE_TAX_ID",
            supported_language="de",
            patterns=[Pattern("de_steuerid", r"\b\d{11}\b", 0.4)],
            context=["steuer", "steuer-id", "steueridentifikationsnummer", "idnr", "steuernummer"],
        ),
        # Krankenversichertennummer: letter + 9 digits, e.g. "A123456789".
        PatternRecognizer(
            supported_entity="DE_HEALTH_INSURANCE_ID",
            supported_language="de",
            patterns=[Pattern("de_kvnr", r"\b[A-Z]\d{9}\b", 0.55)],
            context=["versichertennummer", "krankenversicherung", "kv-nummer", "kvnr", "krankenkasse"],
        ),
        # Rentenversicherungs-/Sozialversicherungsnummer, e.g. "65170839J003".
        PatternRecognizer(
            supported_entity="DE_SOCIAL_INSURANCE_ID",
            supported_language="de",
            patterns=[Pattern("de_rvnr", r"\b\d{2}\s?\d{6}\s?[A-Z]\s?\d{3}\b", 0.6)],
            context=["rentenversicherung", "sozialversicherung", "rvnr", "sv-nummer", "versicherungsnummer"],
        ),
        # KFZ-Kennzeichen (license plate), e.g. "E-AB 1234".
        PatternRecognizer(
            supported_entity="DE_LICENSE_PLATE",
            supported_language="de",
            patterns=[Pattern("de_kfz", r"\b[A-ZÄÖÜ]{1,3}-[A-Z]{1,2}\s?\d{1,4}\b", 0.5)],
            context=["kfz", "kennzeichen", "fahrzeug", "auto", "pkw"],
        ),
    ]


def _resolve_overlaps(results: List[RecognizerResult]) -> List[RecognizerResult]:
    """Greedily keep the highest-scoring, non-overlapping spans."""
    ordered = sorted(results, key=lambda r: (-r.score, r.start, -(r.end - r.start)))
    kept: List[RecognizerResult] = []
    for res in ordered:
        if any(not (res.end <= k.start or res.start >= k.end) for k in kept):
            continue
        kept.append(res)
    return kept


class Pseudonymizer:
    """Stateful, reversible pseudonymizer with stable placeholders."""

    _PLACEHOLDER_RE = re.compile(r"\[[A-Z_]+_\d+\]")

    def __init__(self, analyzer: AnalyzerEngine, score_threshold: float = DEFAULT_SCORE_THRESHOLD):
        self._analyzer = analyzer
        self._threshold = score_threshold
        self._counters: Dict[str, int] = {}
        self._value_to_placeholder: Dict[Tuple[str, str], str] = {}
        self.placeholder_to_value: Dict[str, str] = {}

    def _placeholder_for(self, entity_type: str, original: str) -> str:
        label = ENTITY_LABELS.get(entity_type, entity_type)
        key = (label, original)
        existing = self._value_to_placeholder.get(key)
        if existing:
            return existing
        self._counters[label] = self._counters.get(label, 0) + 1
        placeholder = f"[{label}_{self._counters[label]}]"
        self._value_to_placeholder[key] = placeholder
        self.placeholder_to_value[placeholder] = original
        return placeholder

    def mask(self, text: str) -> str:
        if not text or not text.strip():
            return text
        results = self._analyzer.analyze(text=text, language="de", score_threshold=self._threshold)
        kept = _resolve_overlaps(list(results))
        # Replace from right to left so indices stay valid.
        for res in sorted(kept, key=lambda r: r.start, reverse=True):
            original = text[res.start : res.end]
            placeholder = self._placeholder_for(res.entity_type, original)
            text = text[: res.start] + placeholder + text[res.end :]
        return text

    def restore(self, text: str) -> str:
        if not text or "[" not in text:
            return text
        # Longest placeholders first so [PERSON_1] does not shadow [PERSON_11].
        for placeholder in sorted(self.placeholder_to_value, key=len, reverse=True):
            if placeholder in text:
                text = text.replace(placeholder, self.placeholder_to_value[placeholder])
        return text

    def has_mappings(self) -> bool:
        return bool(self.placeholder_to_value)

    def mapping_summary(self) -> Dict[str, str]:
        return dict(self.placeholder_to_value)

    def entity_type_counts(self) -> Dict[str, int]:
        """Non-sensitive audit summary: how many entities per label.

        Derived from the placeholder labels only (e.g. ``[PERSON_1]`` -> label
        ``PERSON``); contains no raw PII, so it is safe to log in production.
        """
        counts: Dict[str, int] = {}
        for placeholder in self.placeholder_to_value:
            match = re.match(r"\[([A-Z_]+)_\d+\]$", placeholder)
            label = match.group(1) if match else placeholder
            counts[label] = counts.get(label, 0) + 1
        return counts


class StreamRestorer:
    """Restores placeholders in a streamed token sequence.

    Buffers just enough text so a placeholder split across SSE chunk
    boundaries (e.g. ``[PER`` + ``SON_1]``) is stitched back together before the
    real value is substituted.
    """

    def __init__(self, pseudonymizer: Pseudonymizer):
        self._pseudo = pseudonymizer
        self._buffer = ""

    def push(self, delta: str) -> str:
        self._buffer += delta
        # Hold back from the last unmatched '[' onward: it may be a partial
        # placeholder that will complete in a later chunk.
        open_idx = self._buffer.rfind("[")
        if open_idx != -1 and "]" not in self._buffer[open_idx:]:
            emit, self._buffer = self._buffer[:open_idx], self._buffer[open_idx:]
        else:
            emit, self._buffer = self._buffer, ""
        return self._pseudo.restore(emit)

    def flush(self) -> str:
        emit, self._buffer = self._buffer, ""
        return self._pseudo.restore(emit)


_ANALYZER: AnalyzerEngine | None = None


def get_analyzer() -> AnalyzerEngine:
    global _ANALYZER
    if _ANALYZER is None:
        _ANALYZER = _build_analyzer()
    return _ANALYZER
