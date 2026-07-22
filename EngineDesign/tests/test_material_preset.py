"""``material_preset`` shares liner/insert MATERIAL constants instead of duplicating them per config.

Material properties are constants of the substance -- one liner material has one heat of ablation
regardless of which engine it lines. They used to be copied verbatim into every config: 61 identical
fields across ``canonical/impinging.yaml`` and ``canonical/pintle.yaml``, repeated again in every
``impinging_*`` config. Nothing kept them in sync, so the first real measurement would have updated
one file and silently diverged the rest.

This mirrors two mechanisms the codebase already had: ``propellant_preset`` (fluid identity) and
``config_switch.apply_injector_type`` (injector-dependent closures). Materials were the gap.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.pipeline.io import load_config  # noqa: E402

PRESET = ROOT / "configs" / "materials" / "phenolic_graphite.yaml"
CANONICAL = ["canonical/impinging.yaml", "canonical/pintle.yaml"]


def _copy_split_config(tmp_path: Path, stem: str) -> Path:
    """Copy canonical/impinging AND its generated sidecar. The intent half alone is not a valid
    config -- chamber geometry, injector geometry and tank pressures live in <stem>.outputs.yaml."""
    src = ROOT / "configs" / "canonical" / "impinging.yaml"
    sidecar = ROOT / "configs" / "canonical" / "impinging.outputs.yaml"
    dst = tmp_path / f"{stem}.yaml"
    dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    (tmp_path / f"{stem}.outputs.yaml").write_text(sidecar.read_text(encoding="utf-8"), encoding="utf-8")
    return dst


@pytest.fixture(scope="module")
def preset_doc() -> dict:
    with open(PRESET, "r", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


@pytest.mark.parametrize("rel", CANONICAL)
def test_canonical_resolves_material_values_from_preset(rel: str, preset_doc: dict) -> None:
    """Every value in the preset must survive into the resolved config."""
    cfg = load_config(str(ROOT / "configs" / rel))
    dumped = cfg.model_dump(mode="json")
    assert dumped.get("material_preset") == "phenolic_graphite"
    for block, fields in preset_doc.items():
        resolved = dumped.get(block) or {}
        for key, expected in fields.items():
            assert resolved.get(key) == pytest.approx(expected), (
                f"{rel}: {block}.{key} resolved to {resolved.get(key)!r}, preset says {expected!r}"
            )


@pytest.mark.parametrize("rel", CANONICAL)
def test_canonical_does_not_inline_preset_material_fields(rel: str, preset_doc: dict) -> None:
    """Regression guard: the whole point is that these live in ONE place.

    Re-inlining a field would silently shadow the preset (explicit-wins), reintroducing exactly the
    duplication this replaced. An intentional per-engine deviation is still allowed -- but it has to
    be added to ALLOWED_OVERRIDES here, so it is a decision someone made rather than a copy-paste.
    """
    ALLOWED_OVERRIDES: set[tuple[str, str]] = set()

    with open(ROOT / "configs" / rel, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)

    inlined = [
        f"{block}.{key}"
        for block, fields in preset_doc.items()
        for key in fields
        if key in (raw.get(block) or {}) and (block, key) not in ALLOWED_OVERRIDES
    ]
    assert not inlined, (
        f"{rel} re-inlines preset-owned material fields: {inlined}. Remove them so the preset stays "
        "authoritative, or add them to ALLOWED_OVERRIDES with a reason if the deviation is intended."
    )


def test_explicit_config_value_overrides_preset(tmp_path: Path) -> None:
    """Explicit-wins must hold, so a genuine per-engine deviation remains possible.

    io._deep_merge_preset logs every override, so this is possible but never silent.
    """
    dst = _copy_split_config(tmp_path, "override")
    with open(dst, "r", encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    doc.setdefault("ablative_cooling", {})["heat_of_ablation"] = 9.99e6
    with open(dst, "w", encoding="utf-8") as fh:
        yaml.safe_dump(doc, fh)

    cfg = load_config(str(dst))
    assert cfg.ablative_cooling.heat_of_ablation == pytest.approx(9.99e6)
    # A non-overridden sibling still comes from the preset.
    assert cfg.ablative_cooling.material_density == pytest.approx(1600.0)


def test_unknown_material_preset_is_a_clear_error(tmp_path: Path) -> None:
    """A typo must fail loudly with the available names, not silently skip the merge."""
    dst = _copy_split_config(tmp_path, "bad")
    with open(dst, "r", encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    doc["material_preset"] = "no_such_material"
    with open(dst, "w", encoding="utf-8") as fh:
        yaml.safe_dump(doc, fh)

    with pytest.raises(FileNotFoundError, match="no_such_material"):
        load_config(str(dst))
