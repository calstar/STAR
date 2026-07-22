"""Every committed engine config must LOAD and EVALUATE at its own design point, and its distance
from its own declared targets is reported.

Two different questions, deliberately separated:

  * **Broken** -- won't load, won't evaluate, non-physical output. Always someone's bug, so it FAILS.
  * **Off-spec** -- evaluates fine but misses its thrust/O-F/dP targets. That is an unconverged
    DESIGN, not a defect, so it is REPORTED and never fails. Blocking commits on it would stop
    work-in-progress designs being checked in, and that pressure is what produces "just widen the
    band until it passes" -- the exact failure mode that put the dP bands and W_SMD where they are.

Absolute pass/fail on design numbers is the wrong CI signal regardless. The useful signal is
*unexplained movement*, which needs history -- see ``scripts/record_runs.py``, which records the
same metrics per commit next to the resolved-config hash so a number that moves while the config
did not is attributable to the commit that moved it.

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
A FAILURE means a config no longer loads or evaluates -- fix the config or the code that broke it.
Configs already in that state are listed in ``KNOWN_BROKEN`` with a reason, and that list is a
RATCHET: an entry that starts evaluating must be removed (``test_known_broken_list_is_current``
enforces it), so the list can only shrink.

Off-spec configs are printed by ``test_reports_off_spec_configs``; run with ``-s`` to see them.
The fix for those is to re-run Layer 1 against the config's requirements so the derived blocks
(chamber_geometry, injector.geometry, tank pressures) are regenerated -- NOT to widen the bands in
the yaml. See the ``W_SMD`` comment in canonical for where that habit leads.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.pipeline.run_record import evaluate_config  # noqa: E402

# Configs that cannot currently load or evaluate, with WHY. Debt, not exemptions -- and only
# genuine breakage belongs here. Off-spec configs are NOT listed; they are reported, not gated.
KNOWN_BROKEN: dict[str, str] = {
    "default.yaml": (
        "sets no propellant_preset, so fluids.oxidizer.name / fluids.fuel.name are both None and "
        "the solver residual goes non-finite; via the runner it yields NEGATIVE thrust "
        "(F=-334N, Isp=-7.27s). No longer the backend startup config (see backend/main.py) -- "
        "still referenced by ~20 scripts/docs, so left in place rather than deleted"
    ),
    "impinging_lox_ch4.yaml": (
        "does not evaluate at its own design point (Supply < Demand at all Pc); 4000N/OF-3.2 "
        "design from an older lineage (hardcodes cea fuel_name/ox_name, no geometry-Cd block)"
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
def test_config_loads_and_evaluates(rel_path: str, verdicts: dict[str, dict]) -> None:
    """BREAKAGE gate: every engine config must load and evaluate at its own design point.

    This is deliberately NOT a "meets its target" check. Missing a thrust target is an unconverged
    design, not a defect -- see ``test_reports_off_spec_configs``. What fails here is a config that
    cannot be loaded or cannot produce a physical answer at all, which is always someone's bug:
    a schema change, a missing propellant preset, a physics change that made it unsolvable.
    """
    v = verdicts[rel_path]
    if v["kind"] == "not_engine":
        pytest.skip(v["detail"])
    if v["kind"] not in ("load_error", "eval_error"):
        return

    problem = f"{v['kind']}: {v['detail']}"
    if rel_path in KNOWN_BROKEN:
        pytest.xfail(f"known broken ({KNOWN_BROKEN[rel_path]}) -- current: {problem}")
    pytest.fail(
        f"{rel_path} cannot be evaluated at its own design point: {problem}\n"
        "This is breakage, not an unconverged design. Either the config is invalid or a code "
        "change made it unsolvable."
    )


def test_reports_off_spec_configs(verdicts: dict[str, dict], capsys) -> None:
    """STATUS report: which configs miss their own declared targets. Never fails.

    Off-spec is design state, not breakage. Enforcing it would block work-in-progress designs from
    being committed -- and that pressure is exactly what produces "just widen the band until it
    passes", which is how the injector dP bands and W_SMD ended up where they are.

    Absolute pass/fail on these numbers is the wrong CI signal anyway. The useful signal is
    *unexplained movement*, which needs history: ``scripts/record_runs.py`` records the same metrics
    per commit alongside the resolved-config hash, so a number that moves while the config did not
    is attributable to the commit that moved it.
    """
    lines = []
    for rel, v in sorted(verdicts.items()):
        if v["kind"] == "checked" and not v["ok"]:
            lines.append(f"  {rel}")
            lines.extend(f"      - {f}" for f in v["failures"])
    with capsys.disabled():
        if lines:
            print(f"\noff-spec configs ({sum(1 for v in verdicts.values() if v.get('kind') == 'checked' and not v['ok'])} "
                  f"of {sum(1 for v in verdicts.values() if v.get('kind') == 'checked')} evaluated):")
            print("\n".join(lines))
        else:
            print("\nall evaluated configs meet their own declared targets")


def test_known_broken_list_is_current(verdicts: dict[str, dict]) -> None:
    """Ratchet: KNOWN_BROKEN may only shrink.

    Without this the exemption list silently becomes permanent -- a config gets fixed, nobody
    removes it, and the next regression is invisible again.
    """
    fixed = [
        rel for rel in KNOWN_BROKEN
        if verdicts.get(rel, {}).get("kind") not in ("load_error", "eval_error")
    ]
    assert not fixed, (
        "These KNOWN_BROKEN entries now load and evaluate -- remove them so future breakage fails "
        f"loudly: {fixed}"
    )

    unknown = sorted(set(KNOWN_BROKEN) - set(_engine_configs()))
    assert not unknown, f"KNOWN_BROKEN names configs that no longer exist: {unknown}"
