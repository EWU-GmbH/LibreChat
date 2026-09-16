"""Tests for German PII masking: recall on real PII, precision on common nouns.

These lock in the precision fix for the gateway: real names + every structured
category must still be masked, while ordinary German nouns (food/objects) and
pronouns must NOT be masked, so the model receives the user's actual words.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gateway.app import _restore_tool_calls
from presidio_analyzer import RecognizerResult

from gateway.pii import (
    Pseudonymizer,
    StreamRestorer,
    _clear_analysis_cache,
    get_analyzer,
)

SAMPLE = (
    "Bitte fasse zusammen: Patient Dr. Katharina Vogel, Kundennummer 4711-8890, "
    "IBAN DE89370400440532013000, wohnhaft Musterstraße 12, 45127 Essen, "
    "Diagnose Hypertonie."
)

# One shared analyzer for the whole module (loading it is expensive).
_ANALYZER = get_analyzer()


def _mask(text: str) -> str:
    return Pseudonymizer(_ANALYZER).mask(text)


def test_mask_and_restore_roundtrip():
    pseudo = Pseudonymizer(_ANALYZER)
    masked = pseudo.mask(SAMPLE)
    print("\nMASKED:", masked)
    print("MAPPING:", pseudo.mapping_summary())

    # The most sensitive raw values must not leak into the masked text.
    for secret in ["Katharina Vogel", "DE89370400440532013000", "4711-8890"]:
        assert secret not in masked, f"leaked: {secret}"

    # Placeholders must be present.
    assert "[IBAN_1]" in masked
    assert any(p.startswith("[PERSON_") for p in pseudo.mapping_summary())

    # Restoring the masked text returns the original.
    restored = pseudo.restore(masked)
    assert "Katharina Vogel" in restored
    assert "DE89370400440532013000" in restored


def test_stream_restorer_splits_placeholder_across_chunks():
    pseudo = Pseudonymizer(_ANALYZER)
    pseudo.mask(SAMPLE)
    # Find the person placeholder to simulate a model echoing it back.
    person_ph = next(p for p in pseudo.mapping_summary() if p.startswith("[PERSON_"))
    person_val = pseudo.mapping_summary()[person_ph]

    text = f"Zusammenfassung fuer {person_ph} mit IBAN [IBAN_1]."
    # Split into single-character chunks to stress the stitching logic.
    restorer = StreamRestorer(pseudo)
    out = "".join(restorer.push(ch) for ch in text)
    out += restorer.flush()
    print("\nSTREAM RESTORED:", out)
    assert person_val in out
    assert pseudo.mapping_summary()["[IBAN_1]"] in out
    assert "[PERSON_" not in out
    assert "[IBAN_" not in out


# --- Precision: common nouns / pronouns must NOT be masked -----------------

# Each item is a (text, must-survive-substring) pair. The substring must remain
# verbatim in the masked output (i.e. it was NOT replaced by a placeholder).
COMMON_NOUN_CASES = [
    ("Erstelle ein Bild von einer Zitrone an einer Bar", "Zitrone"),
    ("Erstelle ein Bild von einer Zitrone an einer Bar", "Bar"),
    ("eine Zitrone an einer Bar", "Zitrone"),
    ("Zitrone", "Zitrone"),
    ("Ich hätte gern einen Apfel und eine Banane zum Essen.", "Apfel"),
    ("Ich hätte gern einen Apfel und eine Banane zum Essen.", "Banane"),
    ("Ich hätte gern einen Apfel und eine Banane zum Essen.", "Ich"),
    ("Das Essen war lecker.", "Essen"),
    ("Der Hund läuft im Garten.", "Hund"),
    ("Auf dem Tisch steht eine Lampe.", "Tisch"),
]


def test_common_nouns_not_masked():
    for text, keep in COMMON_NOUN_CASES:
        masked = _mask(text)
        assert keep in masked, f"common noun wrongly masked: {keep!r} in {text!r} -> {masked!r}"
        assert "[PERSON_" not in masked, f"unexpected PERSON placeholder in {text!r} -> {masked!r}"


# --- Recall: real names must still be masked -------------------------------

REAL_NAME_CASES = [
    ("Angela Merkel war Bundeskanzlerin.", "Angela Merkel"),
    ("Herr Müller kommt morgen.", "Müller"),
    ("Sehr geehrter Herr Dr. Katharina Vogel", "Katharina Vogel"),
    ("Bitte kontaktieren Sie Frau Schmidt.", "Schmidt"),
]


def test_real_names_masked():
    for text, name in REAL_NAME_CASES:
        pseudo = Pseudonymizer(_ANALYZER)
        masked = pseudo.mask(text)
        assert "[PERSON_" in masked, f"name not masked in {text!r} -> {masked!r}"
        # No part of the raw name should survive in the masked text.
        for token in name.split():
            assert token not in masked, f"name leaked: {token!r} in {masked!r}"


# --- Precision: ORGANIZATION / DATE_TIME must NOT be masked ----------------

# spaCy tags product/company names as ORGANIZATION and years/dates as DATE_TIME.
# These carry little PII value and corrupt the prompt when masked, so the
# gateway drops them. Each item lists tokens that must survive verbatim.
ORG_DATE_CASES = [
    ("Ich arbeite bei der Firma Siemens.", ["Siemens"]),
    ("Ich nutze ein iPhone von Apple.", ["iPhone", "Apple"]),
    ("Erstelle ein Bild mit Flux im Jahr 2024.", ["Flux", "2024"]),
    ("Am 15. März 2024 findet das Treffen statt.", ["15", "März", "2024"]),
    ("Das Meeting ist am Montag um 14 Uhr.", ["Montag", "14"]),
    ("Die Zitrone kostet 2 Euro bei Aldi.", ["Zitrone", "Aldi"]),
]


def test_organization_and_date_not_masked():
    for text, survivors in ORG_DATE_CASES:
        masked = _mask(text)
        for tok in survivors:
            assert tok in masked, f"ORG/DATE token wrongly masked: {tok!r} in {text!r} -> {masked!r}"
        assert "[ORGANIZATION_" not in masked, f"ORGANIZATION masked in {text!r} -> {masked!r}"
        assert "[DATE_TIME_" not in masked, f"DATE_TIME masked in {text!r} -> {masked!r}"


def test_date_not_masked_but_name_is():
    # A date and a real name in the same sentence: date survives, name masked.
    masked = _mask("Am 15. März 2024 traf ich Angela Merkel.")
    assert "2024" in masked and "März" in masked
    assert "[PERSON_" in masked
    assert "Angela" not in masked and "Merkel" not in masked


# --- Recall: every structured / regex category must still be masked --------

STRUCTURED_CASES = [
    ("Meine IBAN ist DE89370400440532013000.", "IBAN", "DE89370400440532013000"),
    ("Kontakt: max.mustermann@example.com", "EMAIL", "max.mustermann@example.com"),
    ("Ruf mich an unter 0170 1234567.", "PHONE", "0170 1234567"),
    ("wohnhaft Musterstraße 12", "ADDRESS", "Musterstraße 12"),
    ("wohnhaft Musterstraße 12, 45127 Essen", "PLZ", "45127"),
    ("Kundennummer 4711-8890", "KUNDENNUMMER", "4711-8890"),
    ("Aktenzeichen AZ 12 C 345/24", "AKTENZEICHEN", "12 C 345/24"),
    ("Steuer-ID 12345678901", "STEUERID", "12345678901"),
    ("Versichertennummer A123456789", "KVNUMMER", "A123456789"),
    ("Rentenversicherungsnummer 65 170839 J 003", "RVNUMMER", "65 170839 J 003"),
    ("Mein KFZ-Kennzeichen ist E-AB 1234.", "KFZ", "E-AB 1234"),
    ("Kreditkarte 4111 1111 1111 1111", "CREDIT_CARD", "4111 1111 1111 1111"),
]


def test_structured_categories_masked():
    for text, label, raw in STRUCTURED_CASES:
        pseudo = Pseudonymizer(_ANALYZER)
        masked = pseudo.mask(text)
        assert f"[{label}_" in masked, (
            f"{label} not masked in {text!r} -> {masked!r} (counts={pseudo.entity_type_counts()})"
        )
        assert raw not in masked, f"{label} raw value leaked: {raw!r} in {masked!r}"


# --- Defense in depth: tool-call arguments are restored --------------------

def test_tool_call_arguments_restored():
    pseudo = Pseudonymizer(_ANALYZER)
    # Seed a mapping as if a name had been masked on the request path.
    masked = pseudo.mask("Angela Merkel")
    person_ph = next(p for p in pseudo.mapping_summary() if p.startswith("[PERSON_"))
    assert masked == person_ph

    tool_calls = [
        {
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "search",
                "arguments": '{"query": "' + person_ph + '"}',
            },
        }
    ]
    _restore_tool_calls(tool_calls, pseudo)
    assert tool_calls[0]["function"]["arguments"] == '{"query": "Angela Merkel"}'
    assert "[PERSON_" not in tool_calls[0]["function"]["arguments"]


def test_analysis_cache_reuses_spans_without_reusing_pii_values():
    class FakeAnalyzer:
        nlp_engine = None

        def __init__(self):
            self.calls = 0

        def analyze(self, text, language, entities, score_threshold):
            self.calls += 1
            return [
                RecognizerResult(
                    entity_type="EMAIL_ADDRESS",
                    start=0,
                    end=len(text),
                    score=1.0,
                )
            ]

    _clear_analysis_cache()
    analyzer = FakeAnalyzer()
    first = Pseudonymizer(analyzer)
    second = Pseudonymizer(analyzer)

    assert first.mask("erste@example.com") == "[EMAIL_1]"
    assert second.mask("erste@example.com") == "[EMAIL_1]"
    assert second.restore("[EMAIL_1]") == "erste@example.com"
    assert analyzer.calls == 1
    assert first.analysis_stats()["cache_misses"] == 1
    assert second.analysis_stats()["cache_hits"] == 1


def test_analysis_cache_reuses_static_paragraphs_when_one_fragment_changes():
    class FakeAnalyzer:
        nlp_engine = None

        def __init__(self):
            self.calls = 0

        def analyze(self, text, language, entities, score_threshold):
            self.calls += 1
            return []

    _clear_analysis_cache()
    analyzer = FakeAnalyzer()

    Pseudonymizer(analyzer).mask("Statisch A\n\nZeit 1\n\nStatisch B")
    second = Pseudonymizer(analyzer)
    second.mask("Statisch A\n\nZeit 2\n\nStatisch B")

    assert analyzer.calls == 4
    assert second.analysis_stats()["cache_hits"] == 2
    assert second.analysis_stats()["cache_misses"] == 1


if __name__ == "__main__":
    test_mask_and_restore_roundtrip()
    test_stream_restorer_splits_placeholder_across_chunks()
    test_common_nouns_not_masked()
    test_real_names_masked()
    test_organization_and_date_not_masked()
    test_date_not_masked_but_name_is()
    test_structured_categories_masked()
    test_tool_call_arguments_restored()
    print("\nALL TESTS PASSED")
