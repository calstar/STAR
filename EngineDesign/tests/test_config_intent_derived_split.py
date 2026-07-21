"""Configs are split by AUTHORSHIP: what a human types vs what the optimizer writes back.

WHY
---
A config used to hold both halves with nothing marking which was which. That is why staleness was
invisible: a hand-edited requirement and a geometry solved for a DIFFERENT requirement look
identical on disk. ``configs/canonical/<name>.yaml`` now holds intent; ``<name>.design.yaml`` holds
the generated half; ``io._apply_design_sidecar`` overlays them at load so the schema and every
downstream consumer are unchanged.

The split is checkable rather than a matter of taste -- ``io._GENERATED_FIELDS`` lists exactly the
fields something in the codebase assigns. Notably ``chamber_geometry.design_thrust/design_MR/
design_pressure`` and ``nozzle_efficiency`` are NOT generated (nothing assigns them; they are schema
declarations), so they stay intent.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.pipeline.io import (  # noqa: E402
    _GENERATED_FIELDS,
    load_config,
    save_config,
    split_generated,
)

SPLIT = ["impinging", "pintle"]


@pytest.mark.parametrize("stem", SPLIT)
def test_sidecar_exists_and_intent_holds_no_generated_fields(stem: str) -> None:
    """The intent file must not contain generated fields -- that is the whole invariant."""
    intent_path = ROOT / "configs" / "canonical" / f"{stem}.yaml"
    sidecar_path = ROOT / "configs" / "canonical" / f"{stem}.design.yaml"
    assert sidecar_path.exists(), f"missing generated half for {stem}"

    raw = yaml.safe_load(intent_path.read_text(encoding="utf-8"))
    leaked = []
    for block, spec in _GENERATED_FIELDS.items():
        if spec is None:
            if block in raw:
                leaked.append(block)
        elif isinstance(raw.get(block), dict) and isinstance(spec, list):
            leaked += [f"{block}.{k}" for k in spec if k in raw[block]]
    assert not leaked, f"{stem}.yaml hand-sets optimizer-generated fields: {leaked}"


@pytest.mark.parametrize("stem", SPLIT)
def test_generated_half_is_actually_populated(stem: str) -> None:
    """Guard against an empty sidecar silently passing the invariant above."""
    gen = yaml.safe_load((ROOT / "configs" / "canonical" / f"{stem}.design.yaml").read_text(encoding="utf-8"))
    assert gen, "sidecar is empty"
    assert gen["chamber_geometry"]["A_throat"] > 0
    assert gen["injector"]["geometry"]
    assert gen["lox_tank"]["initial_pressure_psi"] > 0


@pytest.mark.parametrize("stem", SPLIT)
def test_load_merges_both_halves(stem: str) -> None:
    cfg = load_config(str(ROOT / "configs" / "canonical" / f"{stem}.yaml"))
    assert cfg.chamber_geometry.A_throat > 0            # from the sidecar
    assert cfg.design_requirements.target_thrust > 0    # from the intent file


def test_collision_between_halves_is_an_error(tmp_path: Path) -> None:
    """Hand-setting a generated field must FAIL, not silently lose the edit on the next run.

    This is the case the split exists to make impossible to miss -- silently preferring either side
    would recreate the original bug in a new place.
    """
    src = ROOT / "configs" / "canonical" / "impinging.yaml"
    doc = yaml.safe_load(src.read_text(encoding="utf-8"))
    doc.setdefault("chamber_geometry", {})["A_throat"] = 0.00123   # generated field, hand-set

    (tmp_path / "c.yaml").write_text(yaml.safe_dump(doc), encoding="utf-8")
    sidecar = ROOT / "configs" / "canonical" / "impinging.design.yaml"
    (tmp_path / "c.design.yaml").write_text(sidecar.read_text(encoding="utf-8"), encoding="utf-8")

    with pytest.raises(ValueError, match="chamber_geometry.A_throat"):
        load_config(str(tmp_path / "c.yaml"))


def test_save_round_trip_keeps_the_split(tmp_path: Path) -> None:
    """Saving a merged config must re-split it, or the next load raises on collisions.

    Regression cover for the backend PUT /api/config path, which used to dump the merged model
    straight into the intent file.
    """
    src = ROOT / "configs" / "canonical" / "impinging.yaml"
    sidecar = ROOT / "configs" / "canonical" / "impinging.design.yaml"
    (tmp_path / "c.yaml").write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    (tmp_path / "c.design.yaml").write_text(sidecar.read_text(encoding="utf-8"), encoding="utf-8")

    merged = load_config(str(tmp_path / "c.yaml")).model_dump(mode="json")
    save_config(merged, tmp_path / "c.yaml")

    # The intent file must not have absorbed the generated half...
    raw = yaml.safe_load((tmp_path / "c.yaml").read_text(encoding="utf-8"))
    assert "A_throat" not in (raw.get("chamber_geometry") or {})
    assert "pressure_curves" not in raw
    # ...and the result must still load and resolve to the same geometry.
    assert load_config(str(tmp_path / "c.yaml")).chamber_geometry.A_throat == pytest.approx(
        merged["chamber_geometry"]["A_throat"]
    )


def test_split_generated_leaves_intent_fields_alone() -> None:
    """design_* and nozzle_efficiency are hand-typed (nothing assigns them) -- they stay in intent."""
    merged = load_config(str(ROOT / "configs" / "canonical" / "impinging.yaml")).model_dump(mode="json")
    intent, generated = split_generated(merged)
    for key in ("design_thrust", "design_MR", "design_pressure", "nozzle_efficiency"):
        assert key in intent["chamber_geometry"], f"{key} should stay in intent"
        assert key not in generated.get("chamber_geometry", {})
    assert "A_throat" in generated["chamber_geometry"]
