"""The pressure relief valve (``relief_valve``, model ``spring``).

Checked against things that are not this code:

* its gas capacity, choked and not, against ``fluids``' own implementation of
  IEC 60534-2-1 (``size_control_valve_g``), which returns the Cv that passes a
  flow -- the valve's own Cv must come back;
* its lift law against ISO 4126-1's terms, by hand: shut below set, open at set,
  shut again only below set x (1 - blowdown);
* on the helium hot-fire drawing, a regulator failed wide open into the fuel
  tank: the tank must be held under set x (1 + overpressure), and with the
  regulator back it must vent down past set to the reseating pressure before the
  valve shuts.

And the drawing contract: an RV that declares no set pressure never lifts, so
it is read as shut -- no branch at all -- and the build says so. (It used to be
built as an always-open Cv valve: a hole to atmosphere on the tank it guards,
which on a pid-designer drawing like LE4's meant the stand could never hold
press.)
"""

from __future__ import annotations

import copy
import json
from dataclasses import replace
from pathlib import Path

import pytest
from fluids.control_valve import size_control_valve_g
from fluids.fittings import Kv_to_Cv

from feedtwin.comps import build_component, conditions_from_fluid
from feedtwin.comps.iec_gas import GasCv
from feedtwin.comps.relief import ReliefValve
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.pid import read_diagram
from feedtwin.props import Fluid
from feedtwin.session import PSI, assemble_model, load_machine
from feedtwin.session.burn import burn_setup, open_session
from feedtwin.session.gauge import ATMOSPHERE, from_psig

STAR = Path(__file__).resolve().parents[3]
DRAWINGS = STAR / "feed-twin" / "backend" / "diagrams"
HE = DRAWINGS / "copv_study_he.json"
TABLES = STAR / "feed-twin" / "backend" / "statemachines"

needs_drawing = pytest.mark.skipif(
    not (HE.exists() and TABLES.is_dir()), reason="helium drawing or tables absent"
)

SET_PSI = 750.0
BORE_MM = 10.92


def _p(value: float, unit: str) -> Param:
    return Param(value, unit, Provenance.ESTIMATED, "test")


def _relief(cv: float = 5.0, **extra: Param) -> ReliefValve:
    params = {
        "Cv": _p(cv, "Cv"),
        "bore": _p(BORE_MM, "mm"),
        "set_pressure": _p(SET_PSI, "psi"),
        **extra,
    }
    component = build_component(
        ComponentInstance.build("RV-1", "relief_valve", params, model="spring")
    )
    assert isinstance(component, ReliefValve)
    return component


def _helium(p: float, T: float = 293.15, lift: float = 1.0):  # type: ignore[no-untyped-def]
    return conditions_from_fluid(
        Fluid("helium"), p, T, {"RV-1.lift": lift}, phase="gas"
    )


# ------------------------------------------------------------- the component


@pytest.mark.parametrize("x", [None, 0.40, 0.10])
def test_gas_flow_is_iec_60534_as_fluids_implements_it(x: float | None) -> None:
    """Choked (x None: discharge to atmosphere) and not: ``fluids`` sizes the
    valve for the flow this one passes, and returns this valve's Cv."""
    valve = _relief(cv=5.0)
    p1 = from_psig(SET_PSI * 1.10)  # the relieving pressure
    flow = _helium(p1)
    p2 = ATMOSPHERE if x is None else p1 * (1.0 - x)
    if x is None:
        assert valve.is_choked(p1 - p2, flow)
        mdot = valve.flow_ceiling(flow)
        assert mdot == pytest.approx(valve.rated_capacity(flow), rel=1e-12)
    else:
        assert not valve.is_choked(p1 - p2, flow)
        # The flow IEC gives at this drop, and the valve's drop at that flow.
        gas = GasCv(5.0, BORE_MM / 1e3, 0.70)
        mdot = gas.flow(p1, flow.rho, flow.gamma_ideal, p1 - p2)
        assert flow.gamma_ideal == pytest.approx(5.0 / 3.0, rel=1e-5)
        assert valve.pressure_drop(mdot, flow) == pytest.approx(p1 - p2, rel=1e-9)
    assert mdot is not None and mdot > 0.0
    molar_mass = 4.002602
    rho_normal = ATMOSPHERE * molar_mass * 1e-3 / (8.314462618 * 273.15)
    sized = size_control_valve_g(
        T=293.15,
        MW=molar_mass,
        mu=flow.mu,
        gamma=5.0 / 3.0,
        Z=Fluid("helium").get("Z", p=p1, T=293.15),
        P1=p1,
        P2=p2,
        Q=mdot / rho_normal,  # fluids' Q is normal m^3/s at 0 degC (its N9)
        D1=BORE_MM / 1e3,
        D2=BORE_MM / 1e3,
        d=BORE_MM / 1e3,
        xT=0.70,
        allow_choked=True,
    )
    # IEC's tabulated N6 against the Cv definition the library scales by: 0.15 %.
    assert Kv_to_Cv(sized) == pytest.approx(5.0, rel=3e-3)


def test_rated_capacity_by_hand() -> None:
    """W = N6 C (2/3) sqrt(F_gamma xT p1 rho1), IEC 60534-2-1 with N6 = 2.73
    (Cv; kg/h, kPa, kg/m^3), helium (gamma 5/3) at 825 psig and 293.15 K."""
    valve = _relief(cv=4.0)
    p1 = from_psig(825.0)
    flow = _helium(p1)
    rho1 = Fluid("helium").get("rho", p=p1, T=293.15)
    hand = (
        2.73 * 4.0 * (2.0 / 3.0) * ((5.0 / 3.0) / 1.40 * 0.70 * p1 / 1e3 * rho1) ** 0.5
    )
    assert valve.rated_capacity(flow) == pytest.approx(hand / 3600.0, rel=3e-3)


def test_shut_below_set_opens_at_set_and_reseats_with_hysteresis() -> None:
    valve = _relief(
        overpressure=Param(0.10, "-", Provenance.ESTIMATED, "test"),
        blowdown=Param(0.07, "-", Provenance.ESTIMATED, "test"),
    )
    p_set = SET_PSI * PSI
    reseat, full = 0.93 * p_set, 1.10 * p_set
    assert valve.reseat_pressure == pytest.approx(reseat)
    assert valve.full_lift_pressure == pytest.approx(full)

    # Rising from shut: nothing until set; it does not open at reseat.
    for fraction in (0.5, 0.93, 0.99, 0.9999):
        assert valve.lift_for(fraction * p_set, was_open=False) == (0.0, False)
    lift, is_open = valve.lift_for(p_set, was_open=False)
    assert is_open and lift == pytest.approx((p_set - reseat) / (full - reseat))
    assert valve.lift_for(full, True) == (1.0, True)
    assert valve.lift_for(1.3 * p_set, True) == (1.0, True)
    # Falling while open: still open (and lifting less) below set...
    lift, is_open = valve.lift_for(0.96 * p_set, was_open=True)
    assert is_open and 0.0 < lift < 0.41
    # ...until below reseat.
    assert valve.lift_for(0.929 * p_set, was_open=True) == (0.0, False)
    # Same pressure, other history: the hysteresis loop.
    assert valve.lift_for(0.96 * p_set, was_open=False) == (0.0, False)


def test_without_a_session_a_relief_is_shut() -> None:
    valve = _relief()
    assert valve.isolates({}) and valve.isolates(None)
    assert valve.isolates({"RV-1.lift": 0.0})
    assert not valve.isolates({"RV-1.lift": 0.5})
    # Half lift, half the Cv: half the choked flow.
    p1 = from_psig(800.0)
    full = valve.flow_ceiling(_helium(p1, lift=1.0))
    half = valve.flow_ceiling(_helium(p1, lift=0.5))
    assert half == pytest.approx(0.5 * full, rel=1e-6)  # type: ignore[operator]


def test_the_model_block_names_its_sources_and_inputs() -> None:
    model = _relief().model()
    assert "ISO 4126-1" in model["source"] and "IEC 60534-2-1" in model["source"]
    assert model["assumptions"]
    inputs = model["inputs"]
    assert inputs["set_pressure"]["value"] == SET_PSI
    assert inputs["blowdown"]["provenance"].startswith("default")
    assert inputs["xT"]["provenance"].startswith("default")


# ----------------------------------------------------------------- drawings


def _drawing(rv_params: dict | None) -> dict:  # type: ignore[type-arg]
    payload = copy.deepcopy(json.loads(HE.read_text()))
    if rv_params is None:
        return payload
    payload["nodes"].append(
        {
            "id": "RV_FU",
            "position": {"x": 600, "y": 520},
            "data": {
                "componentType": "RV",
                "label": "RV-FUEL",
                "fluid": "helium",
                "params": rv_params,
            },
        }
    )
    payload["edges"].append(
        {
            "id": "l_rv",
            "source": "FUT",
            "target": "RV_FU",
            "data": {
                "lineType": "pipe",
                "params": {
                    "length": {
                        "value": 0.1,
                        "unit": "m",
                        "source": "estimated",
                        "reference": "test",
                    },
                    "bore": {
                        "value": BORE_MM,
                        "unit": "mm",
                        "source": "estimated",
                        "reference": "test",
                    },
                },
            },
        }
    )
    return payload


def _rv_params(cv: float, set_psi: float | None) -> dict:  # type: ignore[type-arg]
    params = {
        "Cv": {"value": cv, "unit": "Cv", "source": "estimated", "reference": "test"},
        "bore": {
            "value": BORE_MM,
            "unit": "mm",
            "source": "estimated",
            "reference": "test",
        },
    }
    if set_psi is not None:
        params["set_pressure"] = {
            "value": set_psi,
            "unit": "psi",
            "source": "estimated",
            "reference": "test",
        }
    return params


@needs_drawing
def test_an_rv_without_a_set_pressure_is_shut_and_says_so() -> None:
    model = assemble_model(
        read_diagram(_drawing(_rv_params(5.0, None)), name="rv"), diagram_id="rv"
    )
    # A relief that never lifts is a branch that is not there: no hole to
    # atmosphere on the fuel tank, and its line ends at a capped port.
    assert "RV_FU" not in model.built.network.branches
    assert "l_rv" not in model.built.network.branches
    assert any(
        w.startswith("RV-FUEL") and "read as shut" in w for w in model.report.warnings
    )


@needs_drawing
def test_an_rv_with_a_set_pressure_is_a_relief_on_the_ullage() -> None:
    model = assemble_model(
        read_diagram(_drawing(_rv_params(5.0, SET_PSI)), name="rv"), diagram_id="rv"
    )
    component = model.built.network.branches["RV_FU"].component
    assert isinstance(component, ReliefValve)
    assert not any("not a relief model" in w for w in model.report.warnings)
    assert model.built.network.branches["l_rv"].upstream == "FUT"
    assert model.built.network.nodes["RV_FU.in"].phase == "gas"


@needs_drawing
def test_shipped_drawings_have_no_relief_and_build_as_before() -> None:
    for name in ("copv_study_he", "copv_study_gn2", "ethalox_stand"):
        path = DRAWINGS / f"{name}.json"
        if not path.exists():
            continue
        model = assemble_model(
            read_diagram(json.loads(path.read_text()), name=name), diagram_id=name
        )
        assert not any(
            getattr(b.component, "type", "") == "relief_valve"
            for b in model.built.network.branches.values()
        ), name
        session = open_session(model, load_machine(tables=TABLES), setup=burn_setup())
        assert session._reliefs == []


@needs_drawing
def test_a_relief_holds_the_fuel_tank_when_the_regulator_fails_open() -> None:
    """The dome regulator failed wide open (dome above the bottle) into the fuel
    tank alone, a relief set at 750 psig on the tank. Half full, so the ullage
    is litres rather than the shipped 0.43 L and the test runs in seconds.

    Below set the relief is shut. Failed open, the tank pops it and is held
    under set + 10 % (the overpressure at which the valve is at full lift) with
    the relief passing what the regulator delivers. Regulator restored, the tank
    vents down *past* set to the reseating pressure before the valve shuts.
    """
    cv = 8.0
    model = assemble_model(
        read_diagram(_drawing(_rv_params(cv, SET_PSI)), name="rv"), diagram_id="rv"
    )
    session = open_session(model, load_machine(tables=TABLES), setup=burn_setup())
    session.prime(fill_fraction=0.5, tank_psi=550.0, copv_psi=4500.0, state="Ready")
    session.set_valve("SV_FUEL_PRESS", True)
    session.set_valve("SV_LOX_PRESS", False)
    tank = session.tanks["FUT"]
    relief = model.built.network.branches["RV_FU"].component
    assert isinstance(relief, ReliefValve)
    p_set = from_psig(SET_PSI)
    reseat = ATMOSPHERE + relief.reseat_pressure
    full = ATMOSPHERE + relief.full_lift_pressure

    def held() -> float:
        return tank.state.ullage.mass + tank.state.vapour_mass

    def run(seconds: float):  # type: ignore[no-untyped-def]
        rows = []
        for _ in range(int(round(seconds / 0.02))):
            before = held()
            sample = session.step(0.02)
            rows.append(
                (
                    tank.pressure,
                    sample.signals.get("RV-FUEL.lift", 0.0),
                    sample.flows.get("RV_FU", 0.0),
                    sample.flows.get("PR_D", 0.0),
                    (held() - before) / 0.02,
                )
            )
            assert not session.tripped
        return rows

    # Regulating normally: the relief never moves.
    quiet = run(0.2)
    assert all(p < p_set for p, *_ in quiet)
    assert all(lift == 0.0 and flow == 0.0 for _, lift, flow, *_ in quiet)

    # Failed open.
    session.setup = replace(session.setup, dome_psi=6000.0)
    failed = run(0.6)
    peak = max(p for p, *_ in failed)
    assert peak > p_set, "the regulator never carried the tank to the relief"
    assert peak < full, (peak / PSI, full / PSI)
    # And well inside it: the valve pops on the coupling step its tank crossed
    # set (the session re-solves when a relief flips), not a 20 ms tick later.
    assert peak < p_set + 0.5 * (full - p_set), (peak / PSI, full / PSI)
    assert any(lift > 0.0 for _, lift, *_ in failed)
    # Held, part-lifted, carrying most of what the regulator delivers; the
    # ullage keeps the rest (in - out = what it gained: the vent is booked). The
    # flows are the tick's last coupling step and the gain is the whole tick's,
    # hence the band; an unbooked vent would gain all of the inflow.
    for p, lift, out, inflow, gained in failed[-5:]:
        assert 0.0 < lift < 1.0
        assert 0.5 * inflow < out < inflow
        assert inflow - out == pytest.approx(gained, rel=0.15, abs=1e-4)

    # Regulator restored: vents past set, shuts near reseat, and stays shut.
    session.setup = replace(session.setup, dome_psi=500.0)
    restored = run(0.6)
    shut_at = next(i for i, (_, lift, *_) in enumerate(restored) if lift == 0.0)
    assert restored[shut_at][0] < p_set - 0.5 * (p_set - reseat)
    assert restored[shut_at][0] > reseat - 0.04 * (p_set - ATMOSPHERE)
    assert all(lift == 0.0 and flow == 0.0 for _, lift, flow, *_ in restored[shut_at:])
