"""The tank columns a burn records, and the liquid surface among them.

A saturation margin at the tank is the tank pressure against the vapour pressure
of the liquid the ullage touches. With stratification on that is the surface
layer, not the bulk, and the trace has to carry it (EngineDesign/docs/layerx/
AUDIT.md 5.4). Off, the surface *is* the bulk, and the column says so exactly.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from feedtwin.pid import read_diagram
from feedtwin.session import assemble_model, load_machine
from feedtwin.session.burn import TANK_FIELDS, BurnPlan, burn_setup, open_session
from feedtwin.session.burn import run_burn

STAR = Path(__file__).resolve().parents[3]
STAND = STAR / "feed-twin" / "backend" / "diagrams" / "ethalox_stand.json"
TABLES = STAR / "feed-twin" / "backend" / "statemachines"

pytestmark = pytest.mark.skipif(
    not (STAND.exists() and TABLES.is_dir()), reason="stand drawing or tables absent"
)

PLAN = BurnPlan(tank_psi=550.0, settle=False, lead_in_s=0.5, horizon_s=0.0)


def _trace(**setup):  # type: ignore[no-untyped-def]
    model = assemble_model(
        read_diagram(json.loads(STAND.read_text()), name="ethalox_stand"),
        diagram_id="ethalox_stand.json",
    )
    session = open_session(
        model, load_machine(tables=TABLES), setup=burn_setup(**setup)
    )
    return session, run_burn(session, PLAN)


def test_the_surface_temperature_is_recorded() -> None:
    assert "surface_temperature_K" in TANK_FIELDS
    session, trace = _trace()
    for tank, columns in trace.tank.items():
        assert len(columns["surface_temperature_K"]) == len(trace.t)
        # Stratification off (the burn's setting): the surface is the bulk.
        assert columns["surface_temperature_K"] == columns["liquid_temperature_K"]


def test_with_stratification_on_it_is_the_layer() -> None:
    session, trace = _trace(stratification=True)
    for tank, sim in session.tanks.items():
        column = trace.tank[tank]["surface_temperature_K"]
        assert sim.state.surface_temperature is not None
        assert column[-1] == sim.state.surface_temperature
    # LOX over the hold: the layer the ullage sees and the saturation margin it
    # sets, p_tank - p_sat(T_surface), computable from the trace alone.
    lox = session.tanks["OXT"]
    T_surface = trace.tank["OXT"]["surface_temperature_K"][-1]
    # The leak and the warm pressurant warm the layer, not the bulk.
    assert T_surface > trace.tank["OXT"]["liquid_temperature_K"][-1] + 0.01
    p_sat = lox.tank.liquid.get("p", T=T_surface, q=0.0)
    margin = trace.tank["OXT"]["pressure_Pa"][-1] - p_sat
    assert margin > 0.0
