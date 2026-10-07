"""A LOX load pushed in by a dewar (``Setup.dewar_psi``).

The load is a flow through the fill line at the dewar's pressure less the
tank's. Into a warm tank it boils on the wall and the vapour goes into the
ullage -- the climb the stand shows during a chilldown -- and once the wall is
at saturation it collects. Checked here against hand calculation and CoolProp,
not against the session: the line against Crane's Cv relation and Clamond, the
chill against ``h_fg`` per gram, and a zero dewar against the fixed-rate load
it replaces.
"""

from __future__ import annotations

import math
from dataclasses import replace

import CoolProp.CoolProp as CP
import pytest
from fluids.friction import Clamond

from feedtwin.props import Fluid
from feedtwin.session.core import FILL_LINE_ROUGHNESS, TankSim
from feedtwin.session.gauge import from_psig
from feedtwin.vessels import CylindricalTank, Tank

WALL_MASS = 3.63  # kg, LE4's 8.19 L aluminium tank
WALL_CP = 897.0  # J/(kg K)


def _sim(
    *, liquid_mass: float = 0.0, wall_K: float = 293.15, fuel: bool = False
) -> TankSim:
    liquid = Fluid("ethanol" if fuel else "oxygen")
    tank = Tank(
        liquid,
        Fluid("nitrogen"),
        CylindricalTank(diameter=0.152, barrel_length=0.40),
        wall_mass=WALL_MASS,
        wall_capacity=WALL_CP,
        boiling_onset=2.0,
    )
    state = tank.initial_state(
        pressure=from_psig(0.0),
        liquid_mass=liquid_mass,
        liquid_temperature=293.15 if fuel else 90.19,
        gas_temperature=wall_K,
        split_wall=True,
    )
    # An empty tank's wetted wall is the same metal as the rest of it.
    state = replace(state, wetted_wall_temperature=wall_K)
    return TankSim(
        id="T",
        label="T",
        tank=tank,
        state=state,
        ullage_node="u",
        outlet_node="o",
        filling=True,
        fill_seconds=120.0,
        dewar_pressure=from_psig(100.0),
        fill_line_bore=7.75e-3,
        fill_line_length=3.0,
        fill_cv=0.013,
    )


def test_the_fill_line_is_crane_and_clamond() -> None:
    """Liquid through the line: drop = (f L/D + K + 1) rho v^2 / 2, with K from
    Crane's Cv relation K = 891 d^4 / Cv^2 (d in inches) and f Clamond at the
    Reynolds number of the answer."""
    sim = _sim()
    drop = from_psig(100.0) - from_psig(0.0)
    flow = sim.fill_line_flow(drop)
    T = sim.state.liquid_temperature
    rho = CP.PropsSI("D", "T", T, "Q", 0, "Oxygen")
    mu = CP.PropsSI("V", "T", T, "Q", 0, "Oxygen")
    D, L = 7.75e-3, 3.0
    area = math.pi * D * D / 4
    v = flow / (rho * area)
    f = Clamond(rho * v * D / mu, FILL_LINE_ROUGHNESS / D)
    K = 891.0 * (D / 25.4e-3) ** 4 / 0.013**2
    assert drop == pytest.approx((f * L / D + K + 1.0) * rho * v * v / 2, rel=5e-3)


def test_a_clean_line_pours_tens_of_times_what_the_valve_lets_through() -> None:
    """The reason the dewar valve is calibrated rather than left open: a bare
    3/8 in line from 100 psig pours ~0.7 kg/s."""
    sim = _sim()
    throttled = sim.fill_line_flow(from_psig(100.0) - from_psig(0.0))
    sim.fill_cv = 0.0
    clean = sim.fill_line_flow(from_psig(100.0) - from_psig(0.0))
    assert 0.5 < clean < 1.0
    assert clean > 30 * throttled


def test_nothing_flows_back_into_the_dewar() -> None:
    sim = _sim()
    assert sim.fill_line_flow(0.0) == 0.0
    assert sim.fill_line_flow(-1e5) == 0.0


def test_into_a_warm_tank_every_gram_boils_into_the_ullage() -> None:
    """Chilling: nothing collects, the vapour goes into the ullage (where only
    the vent can take it out), and the wall gives up h_fg per gram -- h_fg from
    CoolProp here, not from the model."""
    sim = _sim()
    walls = (sim.state.ullage.wall_temperature, sim.state.wetted_wall_temperature)
    flow = sim.fill_line_flow(sim.dewar_pressure - sim.pressure)
    dt = 0.5
    assert sim._dewar_load(dt)
    assert sim.state.liquid_mass == 0.0
    assert sim.state.vapour_mass == pytest.approx(flow * dt, rel=1e-12)
    assert sim.chill_boiled == pytest.approx(flow * dt, rel=1e-12)
    assert sim.fill_flow == pytest.approx(flow, rel=1e-12)
    T = sim.state.liquid_temperature
    h_fg = CP.PropsSI("H", "T", T, "Q", 1, "Oxygen") - CP.PropsSI(
        "H", "T", T, "Q", 0, "Oxygen"
    )
    fell = [
        w - c
        for w, c in zip(
            walls,
            (sim.state.ullage.wall_temperature, sim.state.wetted_wall_temperature),
        )
    ]
    assert fell[0] == pytest.approx(fell[1], rel=1e-12)
    assert WALL_MASS * WALL_CP * fell[0] == pytest.approx(flow * dt * h_fg, rel=1e-3)


def test_once_the_wall_is_cold_the_load_collects() -> None:
    sim = _sim(wall_K=90.5)
    flow = sim.fill_line_flow(sim.dewar_pressure - sim.pressure)
    assert not sim._dewar_load(0.5)
    assert sim.state.vapour_mass == 0.0
    assert sim.state.liquid_mass == pytest.approx(flow * 0.5, rel=1e-12)


def test_the_last_of_the_wall_boils_and_the_rest_collects() -> None:
    """A step that brings the wall down to saturation splits: what the wall's
    remaining heat boils, and the rest in the liquid."""
    sim = _sim()
    target = CP.PropsSI("T", "P", sim.pressure, "Q", 0, "Oxygen") + 2.0
    warm = target + 1.0
    sim.state = replace(
        sim.state,
        ullage=replace(sim.state.ullage, wall_temperature=warm),
        wetted_wall_temperature=warm,
    )
    sim.fill_line_bore = 30e-3  # a big pour, to finish the chill in one step
    sim.fill_cv = 0.0
    sim._dewar_load(0.5)
    assert sim.state.ullage.wall_temperature == pytest.approx(target, abs=0.05)
    T = sim.state.liquid_temperature
    h_fg = CP.PropsSI("H", "T", T, "Q", 1, "Oxygen") - CP.PropsSI(
        "H", "T", T, "Q", 0, "Oxygen"
    )
    assert sim.state.vapour_mass == pytest.approx(
        WALL_MASS * WALL_CP * 1.0 / h_fg, rel=0.02
    )
    assert sim.state.liquid_mass > 1.0


def test_a_full_tank_takes_no_more() -> None:
    sim = _sim(wall_K=90.5)
    sim.state = replace(sim.state, liquid_mass=sim._wanted())
    sim._dewar_load(0.5)
    assert sim.fill_flow == 0.0
    assert sim.state.liquid_mass == pytest.approx(sim._wanted())


def _advance(sim: TankSim, dt: float) -> None:
    sim.advance(
        dt, mdot_liquid_out=0.0, mdot_gas_in=0.0, mdot_gas_out=0.0, enthalpy_gas_in=0.0
    )


def test_no_dewar_is_the_fixed_rate_load_exactly() -> None:
    """Zero dewar pressure: the load before this existed, wanted / fill_seconds."""
    sim = _sim(wall_K=90.5)
    sim.dewar_pressure = 0.0
    wanted = sim._wanted()
    _advance(sim, 0.5)
    assert sim.state.liquid_mass == pytest.approx(wanted * 0.5 / 120.0, rel=1e-9)
    assert sim.state.vapour_mass == 0.0


def test_a_fuel_load_ignores_the_dewar() -> None:
    """The dewar is a cryogen's. With it on, ethanol still pours at its rate."""
    sim = _sim(fuel=True)
    wanted = sim._wanted()
    _advance(sim, 0.5)
    assert sim.state.liquid_mass == pytest.approx(wanted * 0.5 / 120.0, rel=1e-9)
    assert sim.chill_boiled == 0.0


# ------------------------------------------------------------- on a stand


def _le4_session(**setup: float):  # type: ignore[no-untyped-def]
    """LE4's LOX tank vented through its top disconnect, the cart's valve
    beyond it (``test_pid_drawn_freely._le4_with_top_manifold``)."""
    from pathlib import Path

    from test_pid_drawn_freely import _le4_with_top_manifold, _machine

    from feedtwin.pid import read_diagram
    from feedtwin.session import Session, Setup, assemble_model, load_machine
    from feedtwin.session.statemachine import bind

    _machine()  # skips when the tables are absent
    tables = (
        Path(__file__).resolve().parents[3] / "feed-twin" / "backend" / "statemachines"
    )
    payload = _le4_with_top_manifold()
    for n in payload["nodes"]:
        if n["id"] == "QD" and "vent_cv" in setup:
            n["data"]["params"] = {
                "Cv": {
                    "value": setup.pop("vent_cv"),
                    "unit": "Cv",
                    "source": "measured",
                }
            }
    model = assemble_model(read_diagram(payload, name="le4 top"), diagram_id="t")
    machine = load_machine(tables=tables)
    labels = {
        n.id: n.label for n in model.diagram.nodes if n.id in model.built.actuators
    }
    session = Session(
        model,
        machine,
        bind(machine, labels, roles=model.built.valve_roles),
        setup=replace(Setup(), **setup),
    )
    return session, model


def _chill(seconds: float, **setup: float) -> tuple[float, float]:
    from feedtwin.session.gauge import psig

    session, model = _le4_session(**setup)
    for state in ("Armed", "Ox Fill"):
        session.command_state(state)
    while session.t < seconds:
        sample = session.step(0.5)
    tank = session.tanks["OT"]
    return (
        psig(sample.pressures[model.built.tanks["OT"].ullage]),
        tank.state.liquid_mass,
    )


def test_the_carts_vent_valve_sizes_an_unsized_gse_vent() -> None:
    session, model = _le4_session(gse_vent_cv=0.37)
    assert model.built.gse_vents == ("QD",)
    session.command_state("Armed")
    session.step(0.1)
    assert model.built.network.branches["QD"].component.p["Cv"] == 0.37


def test_a_disconnect_that_gives_its_own_cv_keeps_it() -> None:
    """Turned on against a drawing that sizes the vent, the setup changes
    nothing."""
    session, model = _le4_session(vent_cv=1.1, gse_vent_cv=0.37)
    assert model.built.gse_vents == ()
    session.command_state("Armed")
    session.step(0.1)
    assert model.built.network.branches["QD"].component.p["Cv"] == pytest.approx(1.1)


def test_a_chilling_tank_climbs_and_climbs_more_the_harder_the_dewar_pushes() -> None:
    """The stand: a LOX tank rises while it chills, as far as the vent makes
    it, and the dewar's pressure sets the pour."""
    low, low_liquid = _chill(30.0, dewar_psi=50.0)
    high, high_liquid = _chill(30.0, dewar_psi=100.0)
    assert low_liquid == 0.0 and high_liquid == 0.0, "still chilling: nothing collects"
    assert 5.0 < low < high


@pytest.mark.xfail(
    strict=True,
    reason="2026-10-06: Cv 0.013 was calibrated to the operator's ~30 psig chill "
    "peak against a vent that took air a floor put back (~3 g/s of phantom air "
    "pressing the ullage). With that fixed, 0.013 peaks near 21 psig and ~0.019 "
    "gives 30 -- but shortens the chill to ~4.8 min against the operator's ~10. "
    "Recalibration is the team's call.",
)
def test_the_fill_cv_is_calibrated_to_the_stands_30_psig_chill() -> None:
    high, _ = _chill(30.0, dewar_psi=100.0)
    assert high == pytest.approx(30.0, abs=5.0), "calibrated to the stand's ~30 psig"


def test_without_a_dewar_the_chill_vents_outside_the_ullage_as_before() -> None:
    p, _ = _chill(30.0, dewar_psi=0.0)
    assert p < 5.0


def test_a_chilling_tank_vents_its_boil_off_not_air_the_floor_puts_back() -> None:
    """The vent of a tank chilling under its own boil-off carries that boil-off.

    Split by mass share alone, the vent took the tank's air down to the floor
    (an atmosphere's worth, which the pressurant keeps because it carries the
    ullage's heat capacity) and the floor put it straight back: on LE4, ~3 g/s
    of air that did not exist and 0.2 kg over a load, booked as a guard. The
    vent here carries what the dewar boils into the ullage; the guards must
    book next to nothing of it.
    """
    sim = _sim()
    arrived = 0.0
    dt = 0.05
    for _ in range(600):  # 30 s of chilldown, venting what boils
        flow = sim.fill_line_flow(sim.dewar_pressure - sim.pressure)
        sim.advance(
            dt,
            mdot_liquid_out=0.0,
            mdot_gas_in=0.0,
            mdot_gas_out=flow,
            enthalpy_gas_in=0.0,
            vent_fraction=1.0,
        )
        arrived += sim.fill_flow * dt
    assert sim.chilling, "still chilling: the case being checked"
    assert arrived > 0.1
    assert abs(sim.fixed_kg) < 1e-3 * arrived, (sim.fixed_kg, arrived)
