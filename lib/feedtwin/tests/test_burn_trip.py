"""A vessel trip ends the burn.

The session trips the stand when a vessel goes over the pressure its drawing
rates it for, and from then on returns the frame it failed on. A burn that
carried on stepping integrated that frozen frame to its horizon: on the LE4
audit's fuel tank restated at 600 psi it reported 99,478 N.s over 14 s against
the real ~24,000 (EngineDesign/docs/layerx/AUDIT.md 5.2). The burn now stops on
the step that trips and says which vessel, when, at what pressure, against what.

The helium drawing's regulator climbs the tanks over a burn (its supply-pressure
effect), so a fuel tank restated just above the primed pressure trips a few
tenths of a second after Fire -- not at T-0, and long before the horizon.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from feedtwin.pid import read_diagram
from feedtwin.session import PSI, assemble_model, load_machine
from feedtwin.session.burn import (
    BurnPlan,
    burn_setup,
    open_session,
    plan_with,
    run_burn,
    trip_record,
)
from feedtwin.session.gauge import ATMOSPHERE, from_psig

STAR = Path(__file__).resolve().parents[3]
DRAWING = STAR / "feed-twin" / "backend" / "diagrams" / "copv_study_he.json"
TABLES = STAR / "feed-twin" / "backend" / "statemachines"
ENGINE = STAR / "EngineDesign" / "configs" / "ethalox_doublet_7000N.yaml"
CEA = STAR / "EngineDesign" / "output" / "cache" / "cea_cache_LOX_Ethanol_3D.npz"

pytestmark = pytest.mark.skipif(
    not (DRAWING.exists() and TABLES.is_dir() and ENGINE.exists() and CEA.exists()),
    reason="helium drawing, tables, engine config or CEA table absent",
)

#: Restated fuel tank rating [psig]: above the 550 psig the tanks are primed to,
#: below the ~558 psig the regulator's supply effect carries them to in a second.
MAWP_PSIG = 553.0

PLAN = BurnPlan(
    tank_psi=550.0, loads={"OXT": 6.0, "FUT": 4.0}, settle=False, lead_in_s=0.1,
    horizon_s=2.0,
)  # fmt: skip


def _session(mawp_psig: float | None):  # type: ignore[no-untyped-def]
    import yaml

    from feedtwin.engine.importer import engine_from_config

    payload = copy.deepcopy(json.loads(DRAWING.read_text()))
    if mawp_psig is not None:
        fuel = next(n for n in payload["nodes"] if n["id"] == "FUT")
        fuel["data"]["params"]["MAWP"] = {
            "value": mawp_psig,
            "unit": "psi",
            "source": "estimated",
            "reference": "test: restated so the regulator's climb trips it",
        }
    diagram = read_diagram(payload, name="copv_study_he_trip")
    design = engine_from_config(yaml.safe_load(ENGINE.read_text()), name="7000N")
    model = assemble_model(
        diagram, diagram_id="copv_study_he_trip", engine=design, cea_cache=str(CEA)
    )
    return open_session(model, load_machine(tables=TABLES), setup=burn_setup())


def test_a_mid_burn_trip_ends_the_trace_at_the_trip() -> None:
    session = _session(MAWP_PSIG)
    trace = run_burn(session, PLAN)
    end = trace.end
    assert end is not None and end.tripped is not None
    trip = end.tripped
    assert trip.vessel == "FUT" and trip.kind == "tank"
    limit = from_psig(MAWP_PSIG)
    assert trip.limit == pytest.approx(limit, rel=1e-12)
    assert trip.pressure > limit
    # Over by no more than one step's climb (a psi a second or so).
    assert trip.pressure - limit < 0.5 * PSI
    # Mid-burn: after ignition, and long before the horizon.
    assert 0.0 < trip.t < 1.5
    # The trace stops on the step that tripped -- not at the horizon.
    assert trace.t[-1] == pytest.approx(trip.t, abs=PLAN.dt + 1e-9)
    assert trace.t[-1] < PLAN.horizon_s - 0.4
    assert len(trace.t) == end.steps
    assert end.depleted_s is None and end.tank == ""
    # The last sample is the frame the stand failed on: the tank over its rating.
    assert trace.tank["FUT"]["pressure_Pa"][-1] == pytest.approx(trip.pressure)
    assert all(p <= limit for p in trace.tank["FUT"]["pressure_Pa"][:-1])

    record = trip_record(trace)
    assert record is not None
    assert record["vessel"] == "FUT"
    assert record["t"] == trip.t
    assert record["mawp_psia"] == pytest.approx((MAWP_PSIG * PSI + ATMOSPHERE) / PSI)
    assert record["p_psia"] > record["mawp_psia"]
    assert "MAWP" in record["message"]
    # And the notes say it, so a reader of the notes alone is not misled.
    assert any(note.startswith("Burn stopped at t = ") for note in trace.notes)


def test_no_trip_no_record() -> None:
    session = _session(None)
    trace = run_burn(session, plan_with(PLAN, horizon_s=0.3))
    assert trace.end is not None and trace.end.tripped is None
    assert trip_record(trace) is None
    assert trace.t[-1] > 0.3 - 1e-9
    assert not any(note.startswith("Burn stopped") for note in trace.notes)


def test_a_trip_during_the_settle_burns_nothing() -> None:
    """Restated below the lockup the settle presses to: the stand trips before
    T-0, the settle reports it, and the burn records no steps."""
    session = _session(400.0)
    trace = run_burn(session, plan_with(PLAN, settle=True, settle_max_s=3.0))
    assert trace.t0_settled is False
    assert trace.end is not None and trace.end.tripped is not None
    assert trace.end.steps == 0 and trace.t == []
    assert trace.end.tripped.t == pytest.approx(-PLAN.lead_in_s)
    assert any("tripped during the settle" in note for note in trace.notes)
