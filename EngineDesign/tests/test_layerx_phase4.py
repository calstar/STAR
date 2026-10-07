"""Layer X phase 4: the feed hardware that gets the most from the fixed load.

* Impulse to depletion is arithmetic on the trace: checked by hand on a made-up one, and checked
  not to jump when the depletion slides across a step.
* Grading: violations are relative and add; feasible beats infeasible whatever the objective;
  among feasible, more is better.
* Bounds carry their reasons, from the config's requirements and the drawing's MAWPs.
* End to end, on the 6.5 kN stand: impulse rises with lockup (a higher chamber pressure expands
  further for the same propellant), so the search ends at the top of the range.
"""

from __future__ import annotations

import math
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")

from engine.layerx import DrawingStore, LayerXSettings, prepare  # noqa: E402
from engine.layerx import optimize as opt  # noqa: E402
from engine.layerx.analysis import _impulse_to_depletion  # noqa: E402
from engine.layerx.sources import shipped_drawings_dir  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "ethalox_6500N_doublet_cad_2026-09-28.yaml"
GN2 = "copv_study_gn2"
# The GN2 drawing is a nitrogen-over-LOX hot fire, refused since 2026-10-03 unless acknowledged
# (engine/layerx/prepare.py gn2_on_lox); these tests study its burn, so their settings acknowledge it.
needs_drawing = pytest.mark.skipif(not (shipped_drawings_dir() / f"{GN2}.json").is_file(),
                                   reason="feed-twin's shipped drawings are not next to this checkout")


def _trace(n: int, dt: float, thrust: float, mo: float, mf: float, ox0: float, fu0: float):
    """A constant burn: ``n`` firing steps, each burning ``mo``/``mf`` for ``dt``."""
    t = [dt * (k + 1) for k in range(n)]
    ox = [max(ox0 - mo * dt * (k + 1), 0.0) for k in range(n)]
    fu = [max(fu0 - mf * dt * (k + 1), 0.0) for k in range(n)]
    ch = {"thrust_N": [thrust] * n, "mdot_oxidiser": [mo] * n, "mdot_fuel": [mf] * n}
    trace = SimpleNamespace(t=t, tank={"OX": {"liquid_mass_kg": ox}, "FU": {"liquid_mass_kg": fu}})
    return trace, list(range(n)), ch


def test_impulse_to_depletion_by_hand():
    """2 kg/s LOX, 1.25 kg/s fuel (O/F 1.6), 7 kN, 50 ms steps; 6.61 kg LOX, 4.40 kg fuel. LOX runs
    out first, at 3.305 s. Up to the last full step the burn makes 7000/3.25 N·s per kg; the load
    it can burn is all the LOX and 6.61/1.6 kg of fuel."""
    dt, mo, mf = 0.05, 2.0, 1.25
    trace, fire, ch = _trace(67, dt, 7000.0, mo, mf, 6.61, 4.40)
    impulse, t_dep = _impulse_to_depletion(trace, fire, dt, "OX", "FU", ch)
    burnable = 6.61 * (1.0 + 1.0 / 1.6)
    assert impulse == pytest.approx(7000.0 / 3.25 * burnable, rel=1e-12)
    assert t_dep == pytest.approx(6.61 / 2.0, rel=1e-12)


def test_impulse_to_depletion_does_not_step_with_the_step():
    """Slide the load so the depletion crosses a step boundary: the step-summed impulse jumps by a
    step's worth, the impulse to depletion moves by exactly the extra propellant's share."""
    dt, mo, mf = 0.05, 2.0, 1.25
    out = []
    for ox0 in (6.598, 6.602):  # depletion at 3.299 s and 3.301 s: either side of 3.30
        n = math.ceil(ox0 / (mo * dt) - 1e-9)
        trace, fire, ch = _trace(n, dt, 7000.0, mo, mf, ox0, 4.40)
        stepped = 7000.0 * dt * n
        to_dep, _ = _impulse_to_depletion(trace, fire, dt, "OX", "FU", ch)
        out.append((stepped, to_dep))
    (s1, d1), (s2, d2) = out
    assert s2 - s1 == pytest.approx(7000.0 * dt)  # 350 N·s for 4 g of LOX
    assert d2 - d1 == pytest.approx(7000.0 / 3.25 * 0.004 * (1 + 1 / 1.6), rel=1e-9)  # ~13 N·s


def _graded(**figures):
    base = {"copv_end_psia": 1200.0, "ox_stiffness_min": 0.30, "fuel_stiffness_min": 0.30, "of_mean": 1.5,
            "total_impulse_Ns": 24000.0, "impulse_to_depletion_Ns": 24000.0, "failed_steps": 0}
    base.update(figures)
    e = {"ok": True, "preflight": [], "figures": base, "x": {"lockup_psia": 578.0}, "lockup_psia": 578.0}
    req = opt.OptimizeRequest(dropout_margin_psi=100.0, of_band_rel=0.02)
    return opt.grade(e, req, {"oxidiser": [0.2, 0.4], "fuel": [0.2, 0.4]}, 1.5)


def test_grading_is_relative_and_feasible_first():
    ok = _graded()
    assert ok["violation"] == 0.0 and ok["objective"] == 24000.0
    # Bottle 50 psi short of the 100 psi headroom: half the margin, violation 0.5.
    short = _graded(copv_end_psia=578.0 + 50.0)
    assert short["violation"] == pytest.approx(0.5)
    # Fuel stiffness 0.15 against a 0.20 floor: a quarter short.
    soft = _graded(fuel_stiffness_min=0.15)
    assert soft["violation"] == pytest.approx(0.25)
    # O/F 1.545 is 3 % off 1.5 against a 2 % band: half the band over.
    rich = _graded(of_mean=1.545)
    assert rich["violation"] == pytest.approx(0.5, rel=1e-9)
    both = _graded(copv_end_psia=628.0, fuel_stiffness_min=0.15)
    assert both["violation"] == pytest.approx(0.75)
    # Feasible beats infeasible however much better the infeasible one's objective is.
    better_but_short = _graded(copv_end_psia=628.0, total_impulse_Ns=30000.0)
    assert opt._rank(ok) < opt._rank(better_but_short)
    assert opt._rank(_graded(total_impulse_Ns=24100.0)) < opt._rank(ok)
    # A preflight failure is infeasible.
    failed = opt.grade({"ok": True, "preflight": ["MAWP"], "figures": None, "x": {}},
                       opt.OptimizeRequest(), {}, None)
    assert opt._rank(ok) < opt._rank(failed)


@pytest.fixture(scope="module")
def config():
    return load_config(str(FIXTURE))


@pytest.fixture(scope="module")
def drawing():
    return {d.name: d for d in DrawingStore(None).list()}[GN2]


@needs_drawing
def test_bounds_carry_their_reasons(config, drawing):
    prep = prepare(config, None, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True))
    v = {x.key: x for x in opt.default_variables(prep, config)}
    lock = v["lockup_psia"]
    # The floor is 85 % of the lockup the run starts from (the drawing's dome since 2026-10-07);
    # +15 % is above 600, so the requirements cap the tanks at 600.
    assert lock.hi == pytest.approx(600.0) and "max_lox_tank_pressure_psi" in lock.basis
    assert lock.lo == round(prep.derived["target_lockup_psia"] * 0.85)
    assert v["copv_psig"].hi == pytest.approx(4500.0) and "the bottle pressure the drawing states" in v["copv_psig"].basis
    assert "assumed" in lock.basis and "assumed" in v["copv_psig"].basis
    assert not v["copv_volume_L"].enabled


@needs_drawing
def test_the_search_climbs_to_the_lockup_cap(config, drawing):
    """Lockup only, 550 to 600 psia, a handful of burns. Every burn's impulse to depletion rises
    with its lockup, and the search ends on the cap and says so."""
    req = opt.OptimizeRequest(objective="impulse", max_evaluations=6, verify=False,
                              variables={"lockup_psia": {"lo": 550.0, "hi": 600.0},
                                         "copv_psig": {"enabled": False}})
    res = opt.run_optimize(config, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True), [], req, workers=2)
    pts = sorted((e["x"]["lockup_psia"], e["objective"]) for e in res["history"] if e["objective"] is not None)
    assert len(pts) >= 3
    assert all(b[1] > a[1] for a, b in zip(pts, pts[1:])), pts
    assert res["best"]["x"]["lockup_psia"] == pytest.approx(600.0)
    assert any("finished on a bound" in n for n in res["notes"])
    assert res["best"]["violation"] == 0.0
