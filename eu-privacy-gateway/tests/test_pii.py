"""Smoke tests for German PII masking + reversible restore + stream stitching."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gateway.pii import Pseudonymizer, StreamRestorer, get_analyzer

SAMPLE = (
    "Bitte fasse zusammen: Patient Dr. Katharina Vogel, Kundennummer 4711-8890, "
    "IBAN DE89370400440532013000, wohnhaft Musterstraße 12, 45127 Essen, "
    "Diagnose Hypertonie."
)


def test_mask_and_restore_roundtrip():
    pseudo = Pseudonymizer(get_analyzer())
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
    pseudo = Pseudonymizer(get_analyzer())
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


if __name__ == "__main__":
    test_mask_and_restore_roundtrip()
    test_stream_restorer_splits_placeholder_across_chunks()
    print("\nALL TESTS PASSED")
