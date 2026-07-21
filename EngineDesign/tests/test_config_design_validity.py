"""Every committed engine config must satisfy its OWN declared gates at its OWN design point.

WHY THIS EXISTS (found 2026-07-21)
----------------------------------
The configs mix hand-authored *intent* (``design_requirements``) with optimizer-produced *derived*
output (``chamber_geometry``, ``injector.geometry``, tank pressures, ``pressure_curves``) in one
file, with nothing marking which is which and nothing checking they still agree.

They had silently drifted apart, in two independent ways:

  1. Requirements were edited without re-running Layer 1. ``configs/canonical/impinging.yaml``
     records ``chamber_geometry.design_thrust: 7000`` while ``design_requirements.target_thrust``
     says 8000 -- the geometry block literally documents that it was solved for a different spec.

  2. The physics moved under frozen geometry. Commit 1e3f7426 replaced momentum-reconstruction
     thrust with RPA delivered thrust ("fixes ~(1-eta_c*) over-prediction"), swapped k-e mixing for
     Rupe, and retired shifting equilibrium -- while the checked-in yamls only ever received small
     hand edits. Same geometry, different model => the operating point moved.

The result: NO config passed its own gates, and nothing said so. Injector stiffness
(``dP_inj/Pc``) had drifted to 0.58 on canonical and 0.12 on ``_8000N_optimal`` against a declared
band of [0.2, 0.4] -- in opposite directions, which is exactly what undirected drift looks like.

``docs/CONFIG_SYSTEM.md`` already states the rule ("the chamber is a seed, not a solved design,
until you re-run the optimizer") and describes a ``design_valid_for`` stamp. The stamp was never
written and the check never existed. This is that check.

HOW TO USE IT
-------------
A config that fails is NOT a broken test -- it is a config that needs Layer 1 re-run against its
current requirements. Known-stale configs are listed in ``KNOWN_STALE`` with a reason. That list is
a RATCHET: a config in it that starts passing must be removed (``test_known_stale_list_is_current``
enforces that), so the list can only shrink.

Do NOT fix a failure by widening the bands in the yaml. That is how the bands got to where they
are; see the ``W_SMD`` comment in canonical for the same pattern applied to a weight.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.pipeline.run_record import evaluate_config  # noqa: E402

# Configs that are known stale, with WHY. Each entry is debt, not an exemption -- see module docstring.
KNOWN_STALE: dict[str, str] = {
    "canonical/impinging.yaml": (
        "geometry solved for design_thrust 7000 / design_MR 2.55 vs requirements 8000 / 2.8; "
        "measured F=5774N (0.72x), MR=1.81 (0.64x), eta_O=0.576 vs band [0.2,0.4]"
    ),
    "canonical/pintle.yaml": "not yet audited; pintle path is a previous project's engine",
    "default.yaml": "template/seed config, not a solved design (currently evaluates to NEGATIVE thrust)",
    "impinging_smoke.yaml": "byte-identical results to canonical/impinging -- appears to be a stale copy of it",
    "impinging_lox_ch4.yaml": "does not evaluate at its own design point (Supply < Demand at all Pc)",
    "impinging_lox_ch4_8000N.yaml": "eta_O=0.492 / eta_F=0.514 vs band [0.2,0.4] (drifted stiff)",
    "impinging_lox_ch4_8000N_optimal.yaml": (
        "eta_O=0.121 / eta_F=0.124 -- BELOW its own 0.2 floor and below the ~0.15 conventional "
        "chug limit (drifted soft); the optimizer pushes eta down and nothing caught it"
    ),
}


def _engine_configs() -> list[str]:
    """Committed engine configs, as paths relative to ``configs/``."""
    out: list[str] = []
    cfg_root = ROOT / "configs"
    for p in sorted(cfg_root.glob("*.yaml")) + sorted(cfg_root.glob("canonical/*.yaml")):
        out.append(p.relative_to(cfg_root).as_posix())
    return out


def _evaluate(rel_path: str) -> dict:
    """Evaluate a config at its own declared design point.

    Delegates to ``engine.pipeline.run_record.evaluate_config`` so this guard and the run recorder
    (``scripts/record_runs.py``) cannot drift apart on what "meets its own gates" means -- which is
    the exact class of divergence this whole test exists to catch.
    """
    cwd = os.getcwd()
    os.chdir(ROOT)   # config loading resolves cache/preset paths relative to the project root
    try:
        return evaluate_config(ROOT / "configs" / rel_path)
    finally:
        os.chdir(cwd)


@pytest.fixture(scope="module")
def verdicts() -> dict[str, dict]:
    """Evaluate every config once; each evaluation is seconds, so share across tests."""
    return {rel: _evaluate(rel) for rel in _engine_configs()}


@pytest.mark.parametrize("rel_path", _engine_configs())
def test_config_satisfies_its_own_gates(rel_path: str, verdicts: dict[str, dict]) -> None:
    v = verdicts[rel_path]
    if v["kind"] == "not_engine":
        pytest.skip(v["detail"])

    problem = None
    if v["kind"] in ("load_error", "eval_error"):
        problem = f"{v['kind']}: {v['detail']}"
    elif not v["ok"]:
        problem = "; ".join(v["failures"])

    if problem is None:
        return

    if rel_path in KNOWN_STALE:
        pytest.xfail(f"known stale ({KNOWN_STALE[rel_path]}) -- current: {problem}")

    pytest.fail(
        f"{rel_path} does not satisfy its own declared gates: {problem}\n"
        "Re-run Layer 1 against this config's requirements to regenerate the derived blocks "
        "(chamber_geometry, injector.geometry, tank pressures). Do NOT widen the bands to make "
        "this pass -- see the module docstring."
    )


def test_known_stale_list_is_current(verdicts: dict[str, dict]) -> None:
    """Ratchet: KNOWN_STALE may only shrink.

    Without this the exemption list silently becomes permanent -- a config gets fixed, nobody
    removes it, and the next regression is invisible again.
    """
    def _still_failing(rel: str) -> bool:
        v = verdicts.get(rel, {})
        if v.get("kind") in ("load_error", "eval_error"):
            return True
        return v.get("kind") == "checked" and not v["ok"]

    # Covers both "it got fixed" and "it is no longer checked at all" (e.g. reclassified
    # not_engine): either way the entry is dead and must go, or it shields a future regression.
    stale_entries = [rel for rel in KNOWN_STALE if not _still_failing(rel)]
    assert not stale_entries, (
        "These KNOWN_STALE entries no longer describe a failing config -- remove them so future "
        f"regressions fail loudly: {stale_entries}"
    )

    unknown = sorted(set(KNOWN_STALE) - set(_engine_configs()))
    assert not unknown, f"KNOWN_STALE names configs that no longer exist: {unknown}"
