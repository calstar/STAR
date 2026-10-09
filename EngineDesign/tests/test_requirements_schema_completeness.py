"""Every requirement key Layer 1 reads must be DECLARED in DesignRequirementsConfig.

A pydantic model silently DROPS unknown keys. So a key the optimizer reads but the schema
does not declare cannot be set at all: `PUT /api/config` returns 200 and discards it, a YAML
carrying it loads without it, and the value the optimizer uses is always its hardcoded
fallback. Four such keys even had labelled controls in the Configuration editor, so the UI
offered knobs that did nothing.

Sixteen keys were in that state when this test was written (2026-09-14), including
`max_chamber_length_m`, the throat-area search bounds, and the whole injector ring-geometry
group. This test fails if anyone adds a seventeenth.

The reverse direction is deliberately NOT checked: a declared field with no reader is
harmless (it may be read by Layer 2/3, the frontend, or a future consumer).
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from engine.pipeline.config_schemas import DesignRequirementsConfig

LAYER1 = Path(__file__).resolve().parent.parent / "engine/optimizer/layers/layer1_static_optimization.py"

# Keys read from `requirements` that are NOT design requirements and are supplied by the
# caller at runtime instead. Keep this list short and justified.
RUNTIME_ONLY: set[str] = set()

READ_PATTERNS = (
    r'_requirement_float\(\s*requirements,\s*["\']([A-Za-z0-9_]+)["\']',
    r'_requirement_bool\(\s*requirements,\s*["\']([A-Za-z0-9_]+)["\']',
    r'_requirement_int\(\s*requirements,\s*["\']([A-Za-z0-9_]+)["\']',
    r'requirements\.get\(\s*["\']([A-Za-z0-9_]+)["\']',
    r'_req_lookup\(\s*requirements,\s*["\']([A-Za-z0-9_]+)["\']',
)


def _keys_layer1_reads() -> set[str]:
    src = LAYER1.read_text(encoding="utf-8")
    keys: set[str] = set()
    for pat in READ_PATTERNS:
        keys |= set(re.findall(pat, src))
    return keys - RUNTIME_ONLY


def test_every_key_layer1_reads_is_declared():
    declared = set(DesignRequirementsConfig.model_fields)
    missing = sorted(_keys_layer1_reads() - declared)
    assert not missing, (
        "Layer 1 reads these requirement keys but DesignRequirementsConfig does not declare "
        "them, so pydantic silently drops them and they can never be set:\n  "
        + "\n  ".join(missing)
        + "\n\nAdd each as `Optional[...] = Field(default=None, ...)` whose description states "
          "the optimizer's fallback, and make sure any raw `requirements.get(k, default)` "
          "reader is None-safe -- once declared the key arrives present-with-value-None, so "
          "`.get(k, default)` stops firing and `int(None)` / `float(None)` raises."
    )


def test_the_scan_actually_finds_keys():
    """Guard the guard: if the regexes stop matching, the test above passes vacuously."""
    found = _keys_layer1_reads()
    assert len(found) > 80, f"only found {len(found)} requirement reads - the scan is broken"
    for anchor in ("optimal_of_ratio", "min_Lstar", "W_MOM"):
        assert anchor in found, f"scan missed a known requirement key: {anchor}"


@pytest.mark.parametrize("key", [
    "layer1_enforce_ring_geometry",
    "layer1_impingement_Ld_min",
    "layer1_impingement_Ld_max",
    "max_chamber_length_m",
])
def test_previously_undeclared_keys_now_round_trip(key):
    """These four were readable-but-unsettable and are the reason this test exists."""
    assert key in DesignRequirementsConfig.model_fields
    val = True if key == "layer1_enforce_ring_geometry" else 6.0
    cfg = DesignRequirementsConfig(**{key: val})
    assert getattr(cfg, key) == val, f"{key} did not survive construction"
