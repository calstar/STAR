"""LE4 golden burn: Layer X's pad helium baseline must not move.

The reference is ``docs/layerx/baseline-2026-10-07.json``, written by
``scripts/layerx_baseline.py`` (case ``he_pad``: LE4 on the ``copv_study_he`` hot-fire drawing, on
the pad, erosion replay on, every other ``LayerXSettings`` field at its default). The overnight rule
is that a change moving the LE4 baseline by more than 1 % is reported; this test is what notices.

Slow: one helium burn with the replay loop is ~35-100 s depending on load, so it is skipped unless
``LAYERX_GOLDEN=1`` (the suite registers no ``slow`` marker). ``LAYERX_GOLDEN_BASELINE`` points it at
another baseline file.

What it holds fixed, and what it does not
-----------------------------------------
* **The design is the baseline's own.** The burn uses the config embedded in the baseline JSON,
  not the live ``configs/ethalox_6800N.yaml``, so editing the design does not read as a physics
  change. ``test_embedded_config_round_trips`` checks every field of it survives the schema
  unchanged (a validator that rewrites a stored value *is* an input change).
* **The drawing, the CEA table and the DAQ tables are the checkout's**, and
  ``test_inputs_unchanged`` compares their hashes with the baseline's first. When one of them has
  changed the figures are expected to move: re-run the script, review, and report the move.
* **Everything else is code**: lib/feedtwin, engine/layerx, the engine card, the replay.

Tolerances
----------
Measured: the burn is bitwise reproducible across processes on one machine (three runs, every
figure identical to the last digit), so on the baseline's own platform any non-zero move is a
change. The bands are wider than that on purpose:

* **0.5 % on the integral performance figures** (impulse, burn time, thrust, Pc, O/F): half the
  1 % reporting threshold, so a change that must be reported cannot pass, with room for platform
  drift (CI runs other numpy/CoolProp versions; that drift has not been measured here).
* **0.3 % on Isp**: Isp is a ratio of two integrals that move together; a 0.3 % move in delivered
  Isp is already a material engine change (0.7 s).
* **1 % on the bottle** (pressure and gas used at burnout): the bottle integrates the whole burn's
  gas demand and is a feed-side quantity the 1 % rule reads directly.
* **Absolute bands** where a relative one means nothing: tank pressures 3 psi (0.5 % of the
  ~618 psia peak), injector stiffness 0.003 (1.2 psi of the ~136 psi drop at a ~400 psia chamber,
  ~0.9 % of the value), the other tank's residual 0.02 kg (what an O/F move of ~0.5 % strands),
  the time of the lowest chug margin one 50 ms step.
* **2 % on throat growth and recession**: erosion feeds thrust weakly (a 2 % change in a 4 % area
  growth is ~0.08 % of area); tighter would flag erosion-model edits that cannot move a reported
  figure by 1 %.
* **Exact** on the discrete outcomes: which tank runs dry, converged, no failed steps, no step
  outside the engine card.

Checked against changes made in-process, not in the code: halving the regulator's supply-pressure
effect fails 8 of these (burn time +1.45 %, mean thrust -1.73 %, Pc -1.65 %, bottle +9.5 %, tank
peaks -24 psi) while total impulse moves only -0.30 %: the load is fixed, so impulse alone is a weak
witness to a feed-system change. Loosening the network solve from 1e-6 to 1e-4 passes all of them
(impulse -0.018 %, stiffness -0.15 % of its value). Doubling or shortening the step is a scheme change
and is held out by burning at the baseline's own ``dt`` (0.1 s: impulse +0.08 %; 0.02 s: -0.06 %,
lowest chug margin -0.58 % because its minimum is the first firing sample).
"""

from __future__ import annotations

import importlib.util
import json
import math
import os
from pathlib import Path
from typing import Any, Dict, Tuple

import pytest

ROOT = Path(__file__).resolve().parents[1]
BASELINE = Path(os.environ.get("LAYERX_GOLDEN_BASELINE") or (ROOT / "docs" / "layerx" / "baseline-2026-10-07.json"))
CASE = "he_pad"

pytestmark = [
    pytest.mark.skipif(os.environ.get("LAYERX_GOLDEN") != "1",
                       reason="slow LE4 golden burn: set LAYERX_GOLDEN=1 to run it"),
]

#: key path -> ("rel" | "abs" | "eq", tolerance)
TOLERANCES: Dict[str, Tuple[str, float]] = {
    "total_impulse_Ns": ("rel", 5e-3),
    "burn_time_s": ("rel", 5e-3),
    "mean_thrust_N": ("rel", 5e-3),
    "min_thrust_N": ("rel", 5e-3),
    "max_thrust_N": ("rel", 5e-3),
    "pc_mean_psia": ("rel", 5e-3),
    "of_mean": ("rel", 5e-3),
    "isp_mean_s": ("rel", 3e-3),
    "propellant_used_kg": ("rel", 5e-3),
    "copv_end_psia": ("rel", 1e-2),
    "copv_used_kg": ("rel", 1e-2),
    "ox_tank.peak_psia": ("abs", 3.0),
    "fuel_tank.peak_psia": ("abs", 3.0),
    "ox_tank.min_psia": ("abs", 3.0),
    "fuel_tank.min_psia": ("abs", 3.0),
    "ox_stiffness_min": ("abs", 3e-3),
    "fuel_stiffness_min": ("abs", 3e-3),
    "chug_margin_min": ("rel", 5e-3),
    "chug_margin_min_t_s": ("abs", 0.051),
    "residual_other_kg": ("abs", 0.02),
    "throat_area_growth": ("rel", 2e-2),
    "throat_recession_mm": ("rel", 2e-2),
    "depleted_side": ("eq", 0.0),
    "converged": ("eq", 0.0),
    "failed_steps": ("eq", 0.0),
    "card_outside_steps": ("eq", 0.0),
}


def _script():
    spec = importlib.util.spec_from_file_location("layerx_baseline", ROOT / "scripts" / "layerx_baseline.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _get(d: Dict[str, Any], path: str) -> Any:
    for part in path.split("."):
        d = d[part]
    return d


@pytest.fixture(scope="module")
def baseline() -> Dict[str, Any]:
    if not BASELINE.is_file():
        pytest.fail(f"baseline {BASELINE} is missing; write it with scripts/layerx_baseline.py --out {BASELINE}")
    data = json.loads(BASELINE.read_text())
    assert CASE in data["cases"], f"{BASELINE} has no {CASE!r} case"
    assert isinstance((data.get("inputs") or {}).get("config"), dict), "baseline does not embed its config"
    return data


@pytest.fixture(scope="module")
def burn(baseline) -> Dict[str, Any]:
    pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")
    script = _script()
    config, _ = script.load_engine_config(BASELINE)
    want = baseline["cases"][CASE]
    return script.run_case(CASE, config=config, dt=float(want["settings"]["dt"]))


def test_embedded_config_round_trips(baseline):
    """Every stored field of the baseline's design comes back out of the schema as it went in."""
    script = _script()
    config, _ = script.load_engine_config(BASELINE)
    again = config.model_dump(mode="json")
    moved = []

    def walk(a: Any, b: Any, path: str) -> None:
        if isinstance(a, dict):
            if not isinstance(b, dict):
                moved.append(path)
                return
            for k, v in a.items():
                walk(v, b.get(k, "<missing>"), f"{path}.{k}")
        elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
            for i, (u, v) in enumerate(zip(a, b)):
                walk(u, v, f"{path}[{i}]")
        elif a != b and not (isinstance(a, float) and isinstance(b, float) and math.isclose(a, b, rel_tol=1e-12)):
            moved.append(f"{path}: {a!r} -> {b!r}")

    walk(baseline["inputs"]["config"], again, "config")
    assert not moved, "the schema rewrites the baseline's design: " + "; ".join(moved[:10])


def test_layerx_defaults_unchanged(baseline):
    """The baseline is "today's defaults". A changed default is a changed answer for every run the
    tab starts, so it is reported like a physics change; the burn below still uses the baseline's
    own settings, so the figures isolate the code."""
    pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")
    from dataclasses import asdict

    from engine.layerx import LayerXSettings

    now = {k: v for k, v in asdict(LayerXSettings(drawing_id="")).items() if k != "drawing_id"}
    was = baseline["layerx_settings_defaults"]
    moved = {k: (was.get(k), now.get(k)) for k in set(was) | set(now) if was.get(k) != now.get(k)}
    assert not moved, f"LayerXSettings defaults changed since the baseline (was, now): {moved}"


def test_inputs_unchanged(baseline, burn):
    """The drawing, CEA table and DAQ tables are the ones the baseline burned. If this fails, the
    figures below are expected to move: re-baseline and report the move, do not widen a band."""
    want, got = baseline["cases"][CASE]["inputs"], burn["inputs"]
    changed = [k for k in ("drawing", "cea_table") if want[k]["sha256"] != got[k]["sha256"]]
    if want.get("state_machines_sha256") != got.get("state_machines_sha256"):
        changed.append("state_machines")
    assert not changed, f"inputs changed since the baseline: {changed}"
    assert got["config_sha256"] == want["config_sha256"]


@pytest.mark.parametrize("key", list(TOLERANCES))
def test_he_pad_matches_baseline(baseline, burn, key):
    kind, tol = TOLERANCES[key]
    want = _get(baseline["cases"][CASE]["metrics"], key)
    got = _get(burn["metrics"], key)
    if kind == "eq":
        assert got == want, f"{key}: baseline {want!r}, now {got!r}"
        return
    assert want is not None and got is not None, f"{key}: baseline {want!r}, now {got!r}"
    if kind == "rel":
        moved = got / want - 1.0
        assert abs(moved) <= tol, f"{key}: baseline {want:.6g}, now {got:.6g} ({moved * 100:+.3f} %, band ±{tol * 100:g} %)"
    else:
        moved = got - want
        assert abs(moved) <= tol, f"{key}: baseline {want:.6g}, now {got:.6g} ({moved:+.4g}, band ±{tol:g})"
