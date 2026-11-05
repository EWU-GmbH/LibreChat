"""Unit tests for GLiNER lazy load, single-flight, and idle unload.

These tests mock the ``gliner`` package so CI/dev machines without torch can
still verify the lifecycle. Full NER recall stays covered in ``test_pii.py``.
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from types import ModuleType
from typing import Any, List
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gateway import pii as pii_mod
from gateway.pii import GLiNERRecognizer, ensure_gliner_loaded, find_gliner_recognizer


class _FakeRegistry:
    def __init__(self, recognizers: List[Any]) -> None:
        self.recognizers = recognizers


class _FakeAnalyzer:
    def __init__(self, recognizers: List[Any]) -> None:
        self.registry = _FakeRegistry(recognizers)


@pytest.fixture(autouse=True)
def _reset_gliner_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("GLINER_IDLE_UNLOAD_MINUTES", "20")
    monkeypatch.delenv("GATEWAY_USE_GLINER", raising=False)
    yield


def _install_fake_gliner(monkeypatch: pytest.MonkeyPatch, *, delay_s: float = 0.05) -> MagicMock:
    """Inject a fake ``gliner`` module whose from_pretrained sleeps briefly."""
    load_calls = {"count": 0}
    fake_model = MagicMock()
    fake_model.predict_entities.return_value = []

    class FakeGLiNER:
        @staticmethod
        def from_pretrained(name: str):
            load_calls["count"] += 1
            time.sleep(delay_s)
            return fake_model

    fake_mod = ModuleType("gliner")
    fake_mod.GLiNER = FakeGLiNER  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "gliner", fake_mod)
    return load_calls  # type: ignore[return-value]


def test_recognizer_starts_unloaded():
    recognizer = GLiNERRecognizer(
        model_name="fake/model",
        label_map={"person": "PERSON"},
        threshold=0.3,
    )
    assert recognizer.weights_loaded() is False


def test_ensure_loaded_is_single_flight(monkeypatch: pytest.MonkeyPatch):
    load_calls = _install_fake_gliner(monkeypatch, delay_s=0.1)
    recognizer = GLiNERRecognizer(
        model_name="fake/model",
        label_map={"person": "PERSON"},
        threshold=0.3,
    )

    results: List[bool] = []
    barrier = threading.Barrier(4)

    def worker() -> None:
        barrier.wait()
        results.append(recognizer.ensure_loaded())

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert results == [True, True, True, True]
    assert load_calls["count"] == 1
    assert recognizer.weights_loaded() is True


def test_idle_unload_and_reload(monkeypatch: pytest.MonkeyPatch):
    load_calls = _install_fake_gliner(monkeypatch, delay_s=0.0)
    monkeypatch.setenv("GLINER_IDLE_UNLOAD_MINUTES", "0.001")  # ~0.06s
    recognizer = GLiNERRecognizer(
        model_name="fake/model",
        label_map={"person": "PERSON"},
        threshold=0.3,
    )
    assert recognizer.ensure_loaded() is True
    assert load_calls["count"] == 1

    # Age the last-used stamp so idle unload triggers.
    recognizer._last_used_mono = time.monotonic() - 1.0
    assert recognizer.maybe_idle_unload() is True
    assert recognizer.weights_loaded() is False

    assert recognizer.ensure_loaded() is True
    assert load_calls["count"] == 2


def test_zero_idle_minutes_keeps_model_resident(monkeypatch: pytest.MonkeyPatch):
    _install_fake_gliner(monkeypatch, delay_s=0.0)
    monkeypatch.setenv("GLINER_IDLE_UNLOAD_MINUTES", "0")
    recognizer = GLiNERRecognizer(
        model_name="fake/model",
        label_map={"person": "PERSON"},
        threshold=0.3,
    )
    assert recognizer.ensure_loaded() is True
    recognizer._last_used_mono = time.monotonic() - 10_000
    assert recognizer.maybe_idle_unload() is False
    assert recognizer.weights_loaded() is True


def test_ensure_gliner_loaded_via_analyzer(monkeypatch: pytest.MonkeyPatch):
    load_calls = _install_fake_gliner(monkeypatch, delay_s=0.0)
    recognizer = GLiNERRecognizer(
        model_name="fake/model",
        label_map={"person": "PERSON"},
        threshold=0.3,
    )
    analyzer = _FakeAnalyzer([recognizer])
    assert find_gliner_recognizer(analyzer) is recognizer  # type: ignore[arg-type]
    assert ensure_gliner_loaded(analyzer) is True  # type: ignore[arg-type]
    assert load_calls["count"] == 1


def test_analyze_without_gliner_module_degrades(monkeypatch: pytest.MonkeyPatch):
    import builtins

    orig_import = builtins.__import__

    def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "gliner" or (isinstance(name, str) and name.startswith("gliner.")):
            raise ImportError("no gliner")
        return orig_import(name, globals, locals, fromlist, level)

    monkeypatch.delitem(sys.modules, "gliner", raising=False)
    monkeypatch.setattr(builtins, "__import__", fake_import)

    recognizer = GLiNERRecognizer(
        model_name="fake/model",
        label_map={"person": "PERSON"},
        threshold=0.3,
    )
    assert recognizer.ensure_loaded() is False
    assert recognizer.analyze("Dr. Müller wohnt hier.", entities=["PERSON"]) == []


def test_gliner_idle_unload_minutes_default(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("GLINER_IDLE_UNLOAD_MINUTES", raising=False)
    assert pii_mod.gliner_idle_unload_minutes() == 20.0
