"""A regulator whose drawing gives a supply coefficient and no datum.

The LE4 drawings declare the 1092's 14.7 psi per 1000 psi and no
``inlet_reference``, so the supply term had nothing to be measured from and was
zero: the tanks held flat through a burn whose bottle fell by 3,700 psi, where
TB 1031 puts the outlet ~55 psi higher. ``Setup.regulator_supply_datum`` takes
the datum as the COPV charge (the knob is set against a full bottle). A drawn
datum always wins, and the benchmark scheme keeps it off.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from feedtwin.comps import build_component, conditions_from_fluid
from feedtwin.comps.regulator import SUPPLY_DATUM_SIGNAL, Regulator
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.props import Fluid
from feedtwin.session import PSI, Setup
from feedtwin.session.burn import burn_setup
from feedtwin.session.gauge import from_psig

STAR = Path(__file__).resolve().parents[3]
HE = STAR / "feed-twin" / "backend" / "diagrams" / "copv_study_he.json"
ENGINE = STAR / "EngineDesign" / "configs" / "ethalox_doublet_7000N.yaml"
CEA = STAR / "EngineDesign" / "output" / "cache" / "cea_cache_LOX_Ethanol_3D.npz"
TABLES = STAR / "feed-twin" / "backend" / "statemachines"

S = 14.7  # psi per 1000 psi, as the LE4 drawings declare it


def _p(value: float, unit: str) -> Param:
    return Param(value, unit, Provenance.ESTIMATED, "test")


def _regulator(*, supply: float = S, reference_psia: float = 0.0) -> Regulator:
    params = {
        "setpoint": _p(564.7, "psi"),
        "Cv": _p(0.8, "Cv"),
        "bore": _p(0.23 * 0.0254, "m"),
    }
    if supply:
        params["supply_coefficient"] = _p(supply, "psi/1000psi")
    if reference_psia:
        params["inlet_reference"] = _p(reference_psia, "psi")
    component = build_component(
        ComponentInstance.build("PR-1", "regulator", params, model="droop")
    )
    assert isinstance(component, Regulator)
    return component


def _inlet(psia: float, datum_pa: float | None = None):  # type: ignore[no-untyped-def]
    signals = {} if datum_pa is None else {SUPPLY_DATUM_SIGNAL: datum_pa}
    return conditions_from_fluid(
        Fluid("helium"), psia * PSI, 293.15, signals, phase="gas"
    )


def test_on_in_the_cockpit_off_in_the_benchmark() -> None:
    assert Setup().regulator_supply_datum is True
    assert burn_setup().regulator_supply_datum is False


def test_without_a_datum_the_supply_term_is_zero_as_it_always_was() -> None:
    reg = _regulator()
    full, low = reg.outlet_setpoint(0.0, _inlet(4514.7)), reg.outlet_setpoint(
        0.0, _inlet(1014.7)
    )
    assert full == low == pytest.approx(564.7 * PSI)


def test_the_charge_datum_raises_the_outlet_as_the_bottle_falls() -> None:
    """3,500 psi below a 4,500 psig charge at 14.7 psi per 1000: 51.45 psi."""
    reg = _regulator()
    datum = from_psig(4500.0)
    full = reg.outlet_setpoint(0.0, _inlet(4514.7, datum))
    low = reg.outlet_setpoint(0.0, _inlet(1014.7, datum))
    assert full == pytest.approx(564.7 * PSI, abs=1.0)
    assert (low - full) / PSI == pytest.approx(0.0147 * 3500.0, rel=1e-6)


def test_a_drawn_datum_wins_over_the_charge() -> None:
    drawn = _regulator(reference_psia=3014.7)
    flow = _inlet(1014.7, from_psig(4500.0))
    assert (drawn.outlet_setpoint(0.0, flow) - 564.7 * PSI) / PSI == pytest.approx(
        0.0147 * 2000.0, rel=1e-6
    )


def test_a_regulator_with_no_supply_effect_ignores_the_datum() -> None:
    reg = _regulator(supply=0.0)
    flow = _inlet(1014.7, from_psig(4500.0))
    assert reg.outlet_setpoint(0.0, flow) == pytest.approx(564.7 * PSI)


def _drawing(datum: bool) -> dict:  # type: ignore[type-arg]
    raw = json.loads(HE.read_text())
    if datum:
        return raw
    raw = copy.deepcopy(raw)
    for node in raw["nodes"]:
        if node["id"] == "PR_D":
            del node["data"]["params"]["inlet_reference"]
    return raw


@pytest.mark.skipif(
    not (HE.exists() and ENGINE.exists() and CEA.exists() and TABLES.is_dir()),
    reason="helium drawing, engine, CEA table or tables absent",
)
@pytest.mark.parametrize("drawn_datum", [True, False])
def test_a_burn_off_a_half_empty_bottle(drawn_datum: bool) -> None:
    """Primed with the bottle at 2,500 psig against a 4,500 psig charge.

    A drawing that gives its datum burns identically either way. One that does
    not climbs by the supply term once the datum is on: ~34 psi at 17 per 1000.
    """
    import yaml

    from feedtwin.engine.importer import engine_from_config
    from feedtwin.pid import read_diagram
    from feedtwin.session import assemble_model, load_machine
    from feedtwin.session.burn import BurnPlan, open_session, run_burn

    def fire(on: bool):  # type: ignore[no-untyped-def]
        design = engine_from_config(yaml.safe_load(ENGINE.read_text()), name="7000N")
        model = assemble_model(
            read_diagram(_drawing(drawn_datum), name="he"),
            diagram_id="he",
            engine=design,
            cea_cache=str(CEA),
        )
        session = open_session(
            model,
            load_machine(tables=TABLES),
            setup=burn_setup(regulator_supply_datum=on, copv_target_psi=4500.0),
        )
        plan = BurnPlan(
            tank_psi=550.0,
            copv_psi=2500.0,
            loads={"OXT": 6.0, "FUT": 4.0},
            settle=False,
            lead_in_s=0.1,
            horizon_s=0.6,
        )
        return run_burn(session, plan)

    off, on = fire(False), fire(True)
    rise = max(
        (b - a) / PSI
        for tank, columns in off.tank.items()
        for a, b in zip(columns["pressure_Pa"][-5:], on.tank[tank]["pressure_Pa"][-5:])
    )
    if drawn_datum:
        assert abs(rise) < 0.1
        assert not any("supply effect measured" in n for n in on.notes)
    else:
        assert rise > 10.0
        assert any("supply effect measured from the COPV charge" in n for n in on.notes)
