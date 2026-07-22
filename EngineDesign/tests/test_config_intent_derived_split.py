"""Configs are split by AUTHORSHIP: what a human types vs what the optimizer writes back.

WHY
---
A config used to hold both halves with nothing marking which was which. That is why staleness was
invisible: a hand-edited requirement and a geometry solved for a DIFFERENT requirement look
identical on disk. ``configs/canonical/<name>.yaml`` now holds intent; ``<name>.outputs.yaml`` holds
the generated half; ``io._apply_output_sidecar`` overlays them at load so the schema and every
downstream consumer are unchanged.

The split is checkable rather than a matter of taste -- ``io._OUTPUT_FIELDS`` lists exactly the
fields the optimizer produces. ``chamber_geometry.design_thrust/design_MR/design_pressure`` are the
"what was this geometry SOLVED FOR" stamp: a property of the generated geometry (read by the
geometry re-solve fallback + native kernel), which differs from ``design_requirements.*`` when the
geometry is stale -- so they live with the outputs. ``nozzle_efficiency`` is a hand-typed modelling
assumption and stays intent.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.pipeline.io import (  # noqa: E402
    _OUTPUT_FIELDS,
    load_config,
    save_config,
    split_outputs,
)

SPLIT = ["impinging", "pintle"]


@pytest.mark.parametrize("stem", SPLIT)
def test_sidecar_exists_and_intent_holds_no_generated_fields(stem: str) -> None:
    """The intent file must not contain generated fields -- that is the whole invariant."""
    intent_path = ROOT / "configs" / "canonical" / f"{stem}.yaml"
    sidecar_path = ROOT / "configs" / "canonical" / f"{stem}.outputs.yaml"
    assert sidecar_path.exists(), f"missing generated half for {stem}"

    raw = yaml.safe_load(intent_path.read_text(encoding="utf-8"))
    leaked = []
    for block, spec in _OUTPUT_FIELDS.items():
        if spec is None:
            if block in raw:
                leaked.append(block)
        elif isinstance(raw.get(block), dict) and isinstance(spec, list):
            leaked += [f"{block}.{k}" for k in spec if k in raw[block]]
    assert not leaked, f"{stem}.yaml hand-sets optimizer-generated fields: {leaked}"


@pytest.mark.parametrize("stem", SPLIT)
def test_generated_half_is_actually_populated(stem: str) -> None:
    """Guard against an empty sidecar silently passing the invariant above."""
    gen = yaml.safe_load((ROOT / "configs" / "canonical" / f"{stem}.outputs.yaml").read_text(encoding="utf-8"))
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
    sidecar = ROOT / "configs" / "canonical" / "impinging.outputs.yaml"
    (tmp_path / "c.outputs.yaml").write_text(sidecar.read_text(encoding="utf-8"), encoding="utf-8")

    with pytest.raises(ValueError, match="chamber_geometry.A_throat"):
        load_config(str(tmp_path / "c.yaml"))


def test_save_round_trip_keeps_the_split(tmp_path: Path) -> None:
    """Saving a merged config must re-split it, or the next load raises on collisions.

    Regression cover for the backend PUT /api/config path, which used to dump the merged model
    straight into the intent file.
    """
    src = ROOT / "configs" / "canonical" / "impinging.yaml"
    sidecar = ROOT / "configs" / "canonical" / "impinging.outputs.yaml"
    (tmp_path / "c.yaml").write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    (tmp_path / "c.outputs.yaml").write_text(sidecar.read_text(encoding="utf-8"), encoding="utf-8")

    # material sidecar too, so preset un-merge has something to strip against
    mat = ROOT / "configs" / "materials" / "phenolic_graphite.yaml"
    (tmp_path / "materials").mkdir(exist_ok=True)
    (tmp_path / "materials" / "phenolic_graphite.yaml").write_text(mat.read_text(encoding="utf-8"), encoding="utf-8")

    merged = load_config(str(tmp_path / "c.yaml")).model_dump(mode="json")
    save_config(merged, tmp_path / "c.yaml")

    raw = yaml.safe_load((tmp_path / "c.yaml").read_text(encoding="utf-8"))
    # ...the intent file must not have absorbed the generated half...
    assert "A_throat" not in (raw.get("chamber_geometry") or {})
    assert "pressure_curves" not in raw
    # ...must not re-inline PRESET-provided fields (save writes the resolved dump; without preset
    # un-merge the fluids block + material constants get baked back in, reintroducing duplication)...
    assert "fluids" not in raw, "propellant preset fields re-inlined into intent"
    assert "heat_of_ablation" not in (raw.get("ablative_cooling") or {}), "material preset re-inlined"
    assert raw.get("material_preset") == "phenolic_graphite"   # the NAME stays
    assert (raw.get("ablative_cooling") or {}).get("enabled") is not None  # non-preset fields stay
    # ...and the result must still load and resolve to the same geometry.
    assert load_config(str(tmp_path / "c.yaml")).chamber_geometry.A_throat == pytest.approx(
        merged["chamber_geometry"]["A_throat"]
    )


def test_split_outputs_partitions_chamber_geometry_correctly() -> None:
    """nozzle_efficiency is hand-typed intent; design_* (the solved-for stamp) and the solved
    dimensions are outputs."""
    merged = load_config(str(ROOT / "configs" / "canonical" / "impinging.yaml")).model_dump(mode="json")
    intent, outputs = split_outputs(merged)

    assert intent["chamber_geometry"]["nozzle_efficiency"] > 0
    assert "nozzle_efficiency" not in outputs.get("chamber_geometry", {})

    for key in ("design_thrust", "design_MR", "design_pressure", "A_throat"):
        assert key in outputs["chamber_geometry"], f"{key} should be an output"
        assert key not in intent.get("chamber_geometry", {})


def test_design_stamp_lives_with_the_geometry_it_describes() -> None:
    """The solved-for stamp must sit in the outputs file next to the geometry, so that comparing it
    to design_requirements.* detects staleness. Regression cover for the reclassification."""
    out = yaml.safe_load(
        (ROOT / "configs" / "canonical" / "impinging.outputs.yaml").read_text(encoding="utf-8")
    )
    assert out["chamber_geometry"]["design_thrust"] > 0
    intent = yaml.safe_load((ROOT / "configs" / "canonical" / "impinging.yaml").read_text(encoding="utf-8"))
    assert "design_thrust" not in (intent.get("chamber_geometry") or {})
