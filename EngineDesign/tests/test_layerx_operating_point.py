"""A set-point, optimiser, uncertainty or Hardware candidate burns at the lockup and fill it asks for.

The rail writes the dome dial (``dome_psia``) and the absolute bottle fill (``copv_pressure_psia``)
as soon as a person turns either (2026-10-07), and ``prepare`` reads both first: the dome over a
tank pressure, the absolute fill over a gauge one. Every tool that moves the lockup or the fill
wrote only ``tank_pressure_psia`` / ``copv_pressure_psig`` on top of the rail's settings, so with
either knob turned every candidate burned the rail's point: the set point's secant saw a zero slope
("Mean thrust does not rise with lockup"), the tornado showed no swing for the lockup and the fill,
and "Put the settings on the rail" merged a patch the rail then ignored (LE4 (3), the rail at dome
560 psia / fill 3600 psia: candidates at 600 / 500 psia both burned 557.3 psia, 3585.3 psig).
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")

from engine.layerx import DrawingStore, LayerXSettings, prepare  # noqa: E402
from engine.layerx import diff  # noqa: E402
from engine.layerx import optimize as opt  # noqa: E402
from engine.layerx import setpoint as sp  # noqa: E402
from engine.layerx import uncertainty as unc  # noqa: E402
from engine.layerx.prepare import at_operating_point  # noqa: E402
from engine.layerx.sources import shipped_drawings_dir  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

GN2 = "copv_study_gn2"
CFG = Path(__file__).resolve().parent / "fixtures" / "ethalox_6500N_doublet_cad_2026-09-28.yaml"
needs_drawing = pytest.mark.skipif(not (shipped_drawings_dir() / f"{GN2}.json").is_file(),
                                   reason="feed-twin's shipped drawings are not next to this checkout")


@pytest.fixture(scope="module")
def config():
    return load_config(str(CFG))


@pytest.fixture(scope="module")
def drawing():
    return {d.name: d for d in DrawingStore(None).list()}[GN2]


def _rail(drawing):
    """The rail after a person turned the dome dial and the bottle knob."""
    return LayerXSettings(drawing_id=drawing.id, replay=False, engine_model="native", dome_psia=560.0,
                          copv_pressure_psia=3600.0)


@needs_drawing
def test_a_candidate_burns_its_own_lockup_and_fill(config, drawing):
    rail = prepare(config, None, drawing, _rail(drawing))
    assert rail.ok and rail.derived["dome_source"] == "set on the rail"
    for lockup, fill in ((600.0, 3000.0), (500.0, 4200.0)):
        p = prepare(config, None, drawing, at_operating_point(_rail(drawing), lockup_psia=lockup, fill_psig=fill))
        assert p.derived["target_lockup_psia"] == pytest.approx(lockup, abs=0.01)
        assert p.derived["copv_psig"] == pytest.approx(fill)
        assert p.derived["dome_source"] == "solved for the rail's tank pressure"
    # Only what the candidate sets is cleared: a lockup alone keeps the rail's fill.
    only = at_operating_point(_rail(drawing), lockup_psia=600.0)
    assert only.dome_psia is None and only.copv_pressure_psia == 3600.0


def test_the_optimiser_candidate_clears_the_rail_knobs():
    variables = [opt.Variable("lockup_psia", "Tank pressure", "psia", 500.0, 700.0, 600.0),
                 opt.Variable("copv_psig", "Bottle fill", "psig", 3000.0, 4500.0, 4000.0)]
    st, _ = opt._candidate(LayerXSettings(drawing_id="d", dome_psia=560.0, copv_pressure_psia=3600.0), variables,
                           {"lockup_psia": 610.0, "copv_psig": 3100.0}, None, "impulse", 600.0)
    assert (st.tank_pressure_psia, st.dome_psia, st.copv_pressure_psig, st.copv_pressure_psia) == (610.0, None, 3100.0, None)


def test_the_set_point_burns_each_point_where_it_asks(monkeypatch):
    seen = []

    def fake_prepare(config, runner, drawing, settings, overrides=None):
        seen.append(settings)
        return SimpleNamespace(ok=False, derived={}, checks=[SimpleNamespace(status="fail", label="stub", detail="")])

    import sys

    # ``engine.layerx.prepare`` the attribute is the function; the module is in sys.modules.
    monkeypatch.setattr(sys.modules["engine.layerx.prepare"], "prepare", fake_prepare)
    out = sp.burn_point({"config": None, "drawing": None, "overrides": [], "lockup_psia": 600.0, "fill_psig": 3000.0,
                         "settings": LayerXSettings(drawing_id="d", dome_psia=560.0, copv_pressure_psia=3600.0)})
    assert out["ok"] is False and len(seen) == 1
    s = seen[0]
    assert (s.tank_pressure_psia, s.dome_psia, s.copv_pressure_psig, s.copv_pressure_psia) == (600.0, None, 3000.0, None)


@needs_drawing
def test_the_uncertainty_lockup_and_fill_cases_move_the_burn(config, drawing):
    from dataclasses import replace

    nominal = prepare(config, None, drawing, _rail(drawing))
    found, _ = unc.factors(nominal, config)
    by = {f.key: f for f in found}
    lockup, fill = nominal.derived["target_lockup_psia"], nominal.derived["copv_psig"]
    for case in by["op.lockup"].cases + by["op.fill"].cases:
        p = prepare(config, None, drawing, replace(_rail(drawing), **case.settings))
        moved = (p.derived["target_lockup_psia"] - lockup) if case.factor == "op.lockup" else (p.derived["copv_psig"] - fill)
        assert abs(moved) > 4.0, (case.factor, case.side, moved)


def test_use_these_settings_clears_the_knob_it_replaces():
    cl = {"changes": [{"target": "op:lockup_psia", "after": 596.5}, {"target": "op:copv_psig", "after": 3200.0},
                      {"target": "op:dome_psig", "after": 540.0}]}
    assert diff.settings_patch(cl) == {"tank_pressure_psia": 596.5, "dome_psia": None,
                                       "copv_pressure_psig": 3200.0, "copv_pressure_psia": None}
