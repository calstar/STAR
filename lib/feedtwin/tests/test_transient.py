"""Phase 07: the transient.

Three things are checked here, in increasing order of how badly they fail
silently.

**The scenario timeline** is arithmetic and either right or obviously wrong.

**The state packing** is where an off-by-one produces a run that integrates
beautifully and means nothing, so pack/unpack is round-tripped for every owner
type and the coupling's sign convention is checked against topology.

**The coupled run** is audited for mass conservation on every case, because a
stiff integrator will produce a smooth, plausible, converged trajectory that
quietly creates propellant, and no amount of looking at a pressure trace will
show it.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from feedtwin.comps import build_component
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.model.units import get_unit
from feedtwin.props import Fluid
from feedtwin.solve.network import Network
from feedtwin.transient import (
    Command,
    Coupling,
    GasVolumeOwner,
    SciPyIntegrator,
    Scenario,
    StateLayout,
    TankOwner,
    TransientError,
    TransientSystem,
    registered_actuation_shapes,
    simulate,
)
from feedtwin.vessels import ConductionCollapse, CylindricalTank, GasVolume, Tank

PSI = get_unit("psi").factor
M = Provenance.MANUFACTURER
E = Provenance.ESTIMATED


def comp(cid: str, ctype: str, params: dict[str, Param], model: str = ""):
    return build_component(ComponentInstance.build(cid, ctype, params, model=model))


# --------------------------------------------------------------- the scenario


def test_signals_follow_the_command_timeline() -> None:
    sc = Scenario(
        duration=5.0,
        initial_signals={"MV.command": 0.0},
        commands=[Command(0.10, "MV.command", 1.0, travel_time=0.04, shape="linear")],
    )
    assert sc.signals_at(0.0)["MV.command"] == 0.0
    assert sc.signals_at(0.10)["MV.command"] == 0.0
    assert sc.signals_at(0.12)["MV.command"] == pytest.approx(0.5)
    assert sc.signals_at(0.14)["MV.command"] == pytest.approx(1.0)
    assert sc.signals_at(3.0)["MV.command"] == pytest.approx(1.0)


def test_a_second_command_starts_from_where_the_first_left_it() -> None:
    """A shut command arriving mid-open must not jump back to fully open."""
    sc = Scenario(
        duration=1.0,
        initial_signals={"MV.command": 0.0},
        commands=[
            Command(0.10, "MV.command", 1.0, travel_time=0.20, shape="linear"),
            Command(0.20, "MV.command", 0.0, travel_time=0.20, shape="linear"),
        ],
    )
    # At 0.20 the first command is half done.
    assert sc.signals_at(0.20)["MV.command"] == pytest.approx(0.5)
    # The second then travels down from 0.5, not from 1.0.
    assert sc.signals_at(0.30)["MV.command"] == pytest.approx(0.25)
    assert sc.signals_at(0.40)["MV.command"] == pytest.approx(0.0)


def test_smoothstep_is_continuous_at_both_ends() -> None:
    """No corner for the step controller to trip on."""
    sc = Scenario(
        duration=1.0,
        initial_signals={"V.command": 0.0},
        commands=[Command(0.1, "V.command", 1.0, travel_time=0.1)],
    )
    eps = 1e-6
    for edge in (0.1, 0.2):
        before = sc.signals_at(edge - eps)["V.command"]
        after = sc.signals_at(edge + eps)["V.command"]
        assert abs(after - before) < 1e-4


def test_switch_times_bracket_every_command_edge() -> None:
    sc = Scenario(
        duration=5.0,
        commands=[
            Command(0.1, "A", 1.0, travel_time=0.04),
            Command(4.0, "B", 0.0, travel_time=0.10),
        ],
    )
    assert sc.switch_times == [0.0, 0.1, 0.14, 4.0, 4.1, 5.0]


def test_scenario_rejects_a_command_before_the_run() -> None:
    with pytest.raises(ValueError, match="before the run starts"):
        Scenario(duration=1.0, commands=[Command(-0.1, "A", 1.0)])


def test_actuation_shapes_are_registered_not_hardcoded() -> None:
    assert set(registered_actuation_shapes()) >= {"linear", "smoothstep", "step"}


# ------------------------------------------------------------ the state vector


@pytest.fixture(scope="module")
def copv_owner() -> GasVolumeOwner:
    volume = GasVolume(
        Fluid("nitrogen"),
        volume=0.009,
        wall_mass=6.0,
        wall_capacity=900.0,
        wall_conductance=12.0,
    )
    return GasVolumeOwner(
        "COPV", volume, volume.initial_state(4500 * PSI, 293.15), node="COPV"
    )


@pytest.fixture(scope="module")
def tank_owner() -> TankOwner:
    tank = Tank(
        Fluid("oxygen"),
        Fluid("nitrogen"),
        CylindricalTank(diameter=0.152, barrel_length=0.600),
        collapse=ConductionCollapse(),
    )
    return TankOwner(
        "TANK",
        tank,
        tank.initial_state(
            pressure=500 * PSI,
            liquid_mass=9.0,
            liquid_temperature=90.0,
            gas_temperature=293.15,
        ),
    )


def test_state_round_trips_exactly(
    copv_owner: GasVolumeOwner, tank_owner: TankOwner
) -> None:
    """An off-by-one here integrates smoothly and means nothing."""
    layout = StateLayout([copv_owner, tank_owner])
    original = layout.pack()
    layout.unpack(original)
    assert np.array_equal(layout.pack(), original)
    assert layout.size == 3 + 7  # bottle 3; tank 6 + its wetted wall


def test_state_labels_name_every_slot(
    copv_owner: GasVolumeOwner, tank_owner: TankOwner
) -> None:
    layout = StateLayout([copv_owner, tank_owner])
    assert layout.labels[0] == "COPV.mass"
    assert layout.labels[3] == "TANK.ullage_mass"
    assert len(layout.labels) == layout.size
    named = layout.unpack_named(layout.pack())
    assert named["TANK.liquid_mass"] == pytest.approx(9.0)


def test_duplicate_owner_ids_are_rejected(copv_owner: GasVolumeOwner) -> None:
    with pytest.raises(ValueError, match="share the id"):
        StateLayout([copv_owner, copv_owner])


def test_wrong_length_vector_is_rejected(copv_owner: GasVolumeOwner) -> None:
    layout = StateLayout([copv_owner])
    with pytest.raises(ValueError, match="layout expects"):
        layout.unpack(np.zeros(5))


# ------------------------------------------------------------------ the system


def blowdown_system(duration: float = 2.0) -> tuple[TransientSystem, GasVolumeOwner]:
    """A COPV venting through an orifice. The simplest complete transient."""
    net = Network()
    net.add_node("COPV", "nitrogen", 293.15, pressure=4500 * PSI)
    net.add_node("AMBIENT", "nitrogen", 293.15, pressure=1.0e5)
    net.add_branch(
        "VENT",
        comp(
            "OR-01",
            "gas_orifice",
            {
                "bore": Param(0.8, "mm", M, "vent orifice"),
                "Cd": Param(0.85, "-", E, "rounded entry"),
            },
        ),
        "COPV",
        "AMBIENT",
    )
    volume = GasVolume(Fluid("nitrogen"), volume=0.009)
    owner = GasVolumeOwner(
        "COPV", volume, volume.initial_state(4500 * PSI, 293.15), node="COPV"
    )
    scenario = Scenario(duration=duration, name="vent")
    system = TransientSystem(
        net, [Coupling(owner, "COPV", outflow_branches=("VENT",))], scenario
    )
    return system, owner


def test_blowdown_drains_the_bottle_and_conserves_mass() -> None:
    system, _ = blowdown_system()
    result = simulate(system, samples=400)

    assert result.converged
    start = result.vessel("COPV", "pressure")[0]
    end = result.vessel("COPV", "pressure")[-1]
    assert end < start
    assert result.vessel("COPV", "mass")[-1] < result.vessel("COPV", "mass")[0]

    # The audit is the point: mass out must equal mass lost from the vessel.
    assert result.conservation.relative < 1e-3
    assert result.conservation.mass_out > 0.0


def test_blowdown_cools_the_bottle() -> None:
    """Gas leaving does work on what stays behind. Adiabatic here, so it cools."""
    system, _ = blowdown_system()
    result = simulate(system, samples=200)
    assert result.vessel("COPV", "temperature")[-1] < 293.15


def test_conservation_residual_is_integrator_tolerance_on_a_smooth_run() -> None:
    """On a smooth blowdown the audit is limited by the integrator, not quadrature.

    Adding recorded samples changes nothing -- the trapezoid rule is already
    exact enough for an exponential-ish decay -- while tightening ``rtol`` moves
    it by orders of magnitude. Knowing which of the two is binding is the
    difference between "tighten the solver" and "record more points", and
    guessing wrong wastes an afternoon on the one that does not matter.
    """
    loose_coarse = simulate(blowdown_system()[0], samples=100, rtol=1e-6)
    loose_fine = simulate(blowdown_system()[0], samples=800, rtol=1e-6)
    tight = simulate(blowdown_system()[0], samples=100, rtol=1e-9, atol=1e-12)

    # Eight times the samples buys nothing: quadrature is not the limit here.
    assert loose_fine.conservation.relative == pytest.approx(
        loose_coarse.conservation.relative, rel=0.1
    )
    # A tighter integrator buys three orders of magnitude.
    assert tight.conservation.relative < loose_coarse.conservation.relative / 100.0


def test_blowdown_conserves_mass_to_the_phase_exit_criterion() -> None:
    """Better than one part in 1e8, which is what Phase 07 promised."""
    result = simulate(blowdown_system()[0], samples=800, rtol=1e-11, atol=1e-14)
    assert result.converged
    assert result.conservation.relative < 1e-8


def test_conservation_residual_is_quadrature_when_a_valve_moves() -> None:
    """With a sharp transition the other error source takes over.

    A 50 ms valve inside a 5 s run is exactly what the recorded-sample
    trapezoid handles badly, so here adding samples *is* what helps -- the
    opposite of the smooth case above, and the reason the audit reports a
    number rather than a pass/fail.
    """
    coarse = simulate(full_system(), samples=100).conservation.relative
    fine = simulate(full_system(), samples=800).conservation.relative
    assert fine < coarse / 5.0


def test_a_shut_valve_passes_only_its_leak() -> None:
    system = tank_feed_system(open_at=None)
    result = simulate(system, samples=50)
    assert abs(result.flow("MV")[0]) < 1e-2


def test_opening_a_valve_starts_the_flow() -> None:
    system = tank_feed_system(open_at=0.2)
    result = simulate(system, samples=200)
    flows = result.flow("MV")
    assert abs(flows[0]) < 1e-2
    assert max(flows) > 0.5
    assert result.vessel("TANK", "liquid_mass")[-1] < 8.95


def test_an_unfed_tank_blows_down_and_stalls() -> None:
    """No pressurant in: the ullage expands, cools, and the flow dies.

    This is the case that separates a real ullage model from a fixed-pressure
    boundary. Liquid leaving does work on the gas above it, so tank pressure
    decays even though nothing is leaking -- and once it falls to the injector
    pressure the flow stops and then reverses. A model that held tank pressure
    constant would happily drain the whole tank at full rate, which is the
    single most common way to over-predict a blowdown system.
    """
    result = simulate(tank_feed_system(open_at=0.2), samples=120)
    temperature = result.vessel("TANK", "gas_temperature")
    pressure = result.pressure("TANKOUT")
    flows = result.flow("MV")

    assert temperature[-1] < temperature[0] - 30.0  # the ullage really cooled
    assert pressure[-1] < pressure[0] - 100 * PSI

    peak = max(flows)
    assert peak > 0.5
    assert flows[-1] < 0.3 * peak  # the flow died with the pressure

    # Flow decays monotonically once fully open, which is what a blowdown does.
    flowing = [f for s, f in zip(result.samples, flows) if 0.5 < s.t < 2.5]
    assert all(b <= a + 1e-6 for a, b in zip(flowing, flowing[1:]))


def tank_feed_system(open_at: float | None) -> TransientSystem:
    """Pressurised tank feeding a fixed injector pressure through a main valve."""
    net = Network()
    net.add_node("TANKOUT", "oxygen", 90.0, pressure=500 * PSI)
    net.add_node("MID", "oxygen", 90.0)
    net.add_node("INJ", "oxygen", 90.0, pressure=350 * PSI)
    net.add_branch(
        "MV",
        comp(
            "MV-01",
            "valve",
            {
                "Cv": Param(6.0, "Cv", M, "1/2 ball"),
                "bore": Param(12.7, "mm", M, "1/2"),
                "leak_closed": Param(0.001, "Cv", E, "seat leak"),
            },
        ),
        "TANKOUT",
        "MID",
    )
    net.add_branch(
        "FEED",
        comp(
            "FL-01",
            "pipe",
            {
                "length": Param(2.0, "m", Provenance.MEASURED, "routing"),
                "bore": Param(7.75, "mm", M, "3/8 x 0.035"),
                "roughness": Param(0.0015, "mm", M, "drawn tube"),
                "K_minor": Param(6.0, "-", E, "fitting tally"),
            },
        ),
        "MID",
        "INJ",
    )

    tank = Tank(
        Fluid("oxygen"),
        Fluid("nitrogen"),
        CylindricalTank(diameter=0.152, barrel_length=0.600),
        collapse=ConductionCollapse(),
    )
    owner = TankOwner(
        "TANK",
        tank,
        tank.initial_state(
            pressure=500 * PSI,
            liquid_mass=9.0,
            liquid_temperature=90.0,
            gas_temperature=293.15,
        ),
        node="TANKOUT",
    )
    commands = (
        [Command(open_at, "MV-01.command", 1.0, travel_time=0.05)]
        if open_at is not None
        else []
    )
    scenario = Scenario(
        duration=3.0,
        initial_signals={"MV-01.command": 0.0},
        commands=commands,
    )
    return TransientSystem(
        net,
        [Coupling(owner, "TANKOUT", outflow_branches=("MV",), liquid=True)],
        scenario,
    )


def test_a_valve_command_is_component_scoped() -> None:
    """Two valves must not move together because they share a signal name.

    An unqualified ``"command"`` reaching every valve converges perfectly and
    models a system nobody built, so the component looks for its own id first.
    """
    valve = comp(
        "MV-01",
        "valve",
        {
            "Cv": Param(6.0, "Cv", M, "x"),
            "bore": Param(12.7, "mm", M, "x"),
            "leak_closed": Param(0.001, "Cv", E, "x"),
        },
    )
    from feedtwin.comps import FlowConditions

    def dp(signals: dict[str, float]) -> float:
        return valve.pressure_drop(
            0.7, FlowConditions(rho=1140.0, mu=2e-4, p_upstream=3.4e6, signals=signals)
        )

    wide_open = dp({})
    assert dp({"MV-01.command": 0.0}) > 1e6 * wide_open
    # Another valve's command must not touch this one.
    assert dp({"MV-02.command": 0.0}) == pytest.approx(wide_open)
    # The bare fallback still works for a single-actuator test.
    assert dp({"command": 0.0}) > 1e6 * wide_open


# ------------------------------------------------------------ wiring mistakes


def test_a_vessel_on_an_unknown_node_is_rejected(copv_owner: GasVolumeOwner) -> None:
    net = Network()
    net.add_node("A", "nitrogen", 293.15, pressure=1e5)
    with pytest.raises(ValueError, match="not in the network"):
        TransientSystem(net, [Coupling(copv_owner, "GHOST")], Scenario(duration=1.0))


def test_an_outflow_branch_that_misses_the_node_is_rejected() -> None:
    """A vessel cannot draw through a branch that does not reach it."""
    system, owner = blowdown_system()
    net = system.network
    net.add_node("ELSEWHERE", "nitrogen", 293.15, pressure=2.0e5)
    net.add_branch(
        "OTHER",
        comp(
            "OR-02",
            "gas_orifice",
            {"bore": Param(0.5, "mm", M, "x"), "Cd": Param(0.85, "-", E, "x")},
        ),
        "AMBIENT",
        "ELSEWHERE",
    )
    with pytest.raises(ValueError, match="does not touch its node"):
        TransientSystem(
            net,
            [Coupling(owner, "COPV", outflow_branches=("OTHER",))],
            Scenario(duration=1.0),
        )


def test_one_tank_coupled_twice_is_still_one_state_owner(
    tank_owner: TankOwner,
) -> None:
    """A tank attaches at its ullage and at its outlet. It has one state."""
    net = Network()
    net.add_node("ULLAGE", "nitrogen", 293.15, pressure=500 * PSI)
    net.add_node("TANKOUT", "oxygen", 90.0, pressure=500 * PSI)
    net.add_node("INJ", "oxygen", 90.0, pressure=350 * PSI)
    net.add_branch(
        "FEED",
        comp(
            "FL",
            "pipe",
            {
                "length": Param(1.0, "m", M, "x"),
                "bore": Param(7.75, "mm", M, "x"),
                "roughness": Param(0.0015, "mm", M, "x"),
            },
        ),
        "TANKOUT",
        "INJ",
    )
    system = TransientSystem(
        net,
        [
            Coupling(tank_owner, "ULLAGE"),
            Coupling(tank_owner, "TANKOUT", outflow_branches=("FEED",), liquid=True),
        ],
        Scenario(duration=1.0),
    )
    assert len(system.state_owners) == 1
    assert system.layout.size == 7  # six, plus the tank's wetted wall


def test_outflow_sign_follows_topology() -> None:
    """A branch pointing into a vessel fills it; one pointing out drains it.

    Getting this backwards builds a system that fills a bottle by draining it,
    and it converges perfectly the whole way.
    """
    system, _ = blowdown_system()
    coupling = system.couplings[0]
    # VENT runs COPV -> AMBIENT, so positive branch flow is outflow.
    assert system._signed_outflow(coupling, {"VENT": 0.01}) == pytest.approx(0.01)
    assert system._signed_outflow(coupling, {"VENT": -0.01}) == pytest.approx(-0.01)


# ------------------------------------------------ the regulator degeneracy


def test_a_perfect_regulator_makes_its_branch_indeterminate() -> None:
    """The finding that Phase 07 turned up, pinned so it cannot regress.

    With zero flow droop the branch equation ``(p_up - p_dn) - dp(mdot) = 0``
    is satisfied for *every* mass flow, so its Jacobian row is identically zero
    and the flow is genuinely undetermined. ``check()`` must say so before
    anyone spends an afternoon on a transient that will not converge.
    """
    from feedtwin.comps import FlowConditions

    params = {
        "setpoint": Param(500.0, "psi", M, "x"),
        "supply_coefficient": Param(17.0, "psi/1000psi", M, "x"),
        "inlet_reference": Param(4500.0, "psi", M, "x"),
        "Cv": Param(0.8, "Cv", M, "x"),
        "bore": Param(7.75, "mm", M, "x"),
    }
    flat = comp("PR-01", "regulator", params, model="droop")
    flow = FlowConditions(rho=39.0, mu=1.78e-5, p_upstream=4500 * PSI)

    h = 1e-8
    slope = (
        flat.pressure_drop(0.01 + h, flow) - flat.pressure_drop(0.01 - h, flow)
    ) / (2 * h)
    assert slope == 0.0
    assert "flow_droop" in [v.limit for v in flat.check()]

    drooping = comp(
        "PR-02",
        "regulator",
        {
            **params,
            "flow_droop": Param(20.0, "psi", M, "at rated"),
            "rated_flow": Param(0.05, "kg/s", M, "rated"),
        },
        model="droop",
    )
    slope = (
        drooping.pressure_drop(0.01 + h, flow) - drooping.pressure_drop(0.01 - h, flow)
    ) / (2 * h)
    assert slope == pytest.approx(20.0 * PSI / 0.05, rel=1e-3)
    assert "flow_droop" not in [v.limit for v in drooping.check()]


# ------------------------------------------------------------- the full stack


def full_system() -> TransientSystem:
    """COPV, dome regulator, tank, main valve, engine as a pressure boundary."""
    net = Network()
    net.add_node("COPV", "nitrogen", 293.15, pressure=4500 * PSI)
    net.add_node("ULLAGE", "nitrogen", 293.15, pressure=500 * PSI)
    net.add_node("TANKOUT", "oxygen", 90.0, pressure=500 * PSI)
    net.add_node("MID", "oxygen", 90.0)
    net.add_node("INJ", "oxygen", 90.0, pressure=350 * PSI)

    net.add_branch(
        "REG",
        comp(
            "PR-01",
            "regulator",
            {
                "setpoint": Param(500.0, "psi", M, "PR-01"),
                "supply_coefficient": Param(17.0, "psi/1000psi", M, "Aqua 1092-50"),
                "inlet_reference": Param(4500.0, "psi", M, "at 4500 psi"),
                "flow_droop": Param(20.0, "psi", M, "at rated"),
                "rated_flow": Param(0.05, "kg/s", M, "rated"),
                "Cv": Param(0.8, "Cv", M, "datasheet"),
                "bore": Param(7.75, "mm", M, "3/8 seat"),
            },
            model="droop",
        ),
        "COPV",
        "ULLAGE",
    )
    net.add_branch(
        "MV",
        comp(
            "MV-01",
            "valve",
            {
                "Cv": Param(6.0, "Cv", M, "1/2 ball"),
                "bore": Param(12.7, "mm", M, "1/2"),
                "leak_closed": Param(0.001, "Cv", E, "seat leak"),
            },
        ),
        "TANKOUT",
        "MID",
    )
    net.add_branch(
        "FEED",
        comp(
            "FL-01",
            "pipe",
            {
                "length": Param(2.0, "m", Provenance.MEASURED, "routing"),
                "bore": Param(7.75, "mm", M, "3/8 x 0.035"),
                "roughness": Param(0.0015, "mm", M, "drawn tube"),
                "K_minor": Param(6.0, "-", E, "fitting tally"),
            },
        ),
        "MID",
        "INJ",
    )

    n2 = Fluid("nitrogen")
    copv_volume = GasVolume(
        n2,
        volume=0.009,
        wall_mass=6.0,
        wall_capacity=900.0,
        wall_conductance=12.0,
    )
    copv = GasVolumeOwner(
        "COPV", copv_volume, copv_volume.initial_state(4500 * PSI, 293.15), node="COPV"
    )
    tank_physics = Tank(
        Fluid("oxygen"),
        n2,
        CylindricalTank(diameter=0.152, barrel_length=0.600),
        collapse=ConductionCollapse(),
    )
    tank = TankOwner(
        "TANK",
        tank_physics,
        tank_physics.initial_state(
            pressure=500 * PSI,
            liquid_mass=9.0,
            liquid_temperature=90.0,
            gas_temperature=293.15,
        ),
    )
    scenario = Scenario(
        duration=5.0,
        name="5 s ox-side flow",
        initial_signals={"MV-01.command": 0.0},
        commands=[
            Command(0.20, "MV-01.command", 1.0, travel_time=0.05),
            Command(4.50, "MV-01.command", 0.0, travel_time=0.05),
        ],
    )
    return TransientSystem(
        net,
        [
            Coupling(copv, "COPV", outflow_branches=("REG",)),
            Coupling(tank, "ULLAGE", outflow_branches=("REG",)),
            Coupling(tank, "TANKOUT", outflow_branches=("MV",), liquid=True),
        ],
        scenario,
    )


def test_the_whole_stack_runs_and_conserves() -> None:
    result = simulate(full_system(), samples=200)
    assert result.converged
    assert result.conservation.relative < 1e-2
    assert result.worst_mass_residual() < 1e-6


def test_the_copv_droops_and_the_regulator_outlet_rises() -> None:
    """The coupling the whole tool exists to show.

    The bottle empties, so the regulator's supply-pressure effect lifts its
    outlet. That is the sign people guess wrong, and here it comes out of the
    coupled run rather than being asserted at one operating point.
    """
    result = simulate(full_system(), samples=200)
    copv = result.pressure("COPV")
    assert copv[-1] < copv[0] - 100 * PSI

    # Sample after the valve is open and before it shuts, so flow is steady.
    flowing = [
        s
        for s in result.samples
        if 1.0 < s.t < 4.0 and s.signals["MV-01.command"] > 0.9
    ]
    early, late = flowing[0], flowing[-1]
    assert late.pressures["COPV"] < early.pressures["COPV"]
    assert late.pressures["ULLAGE"] > early.pressures["ULLAGE"]


def test_the_tank_drains_only_while_the_valve_is_open() -> None:
    result = simulate(full_system(), samples=200)
    mass = result.vessel("TANK", "liquid_mass")
    before_open = [m for s, m in zip(result.samples, mass) if s.t < 0.2]
    assert max(before_open) - min(before_open) < 0.01
    assert mass[-1] < mass[0] - 2.0


def test_quasi_steady_margin_is_reported_not_assumed() -> None:
    """The formulation's own error bar, on every run.

    A branch whose inertial timescale approaches the transient being modelled
    is one this formulation cannot represent -- and no step-size change fixes
    that, which is why it is reported rather than absorbed.
    """
    result = simulate(full_system(), samples=200)
    assert "FEED" in result.inertial_timescales
    tau = result.inertial_timescales["FEED"]
    assert 1e-3 < tau < 1e-1  # milliseconds to tens of milliseconds
    margin = result.quasi_steady_margin(5.0)
    assert margin["FEED"] < 0.01  # against the burn, comfortable


def test_state_labels_reach_the_result() -> None:
    result = simulate(full_system(), samples=20)
    assert "COPV.mass" in result.state_labels
    assert "TANK.contact_time" in result.state_labels
    assert result.stack  # provenance of the physics stack that produced it


# --------------------------------------------------------------- the integrator


def test_explicit_methods_are_refused() -> None:
    """This system is stiff by construction: a 50 ms valve and a 5 s bottle."""
    with pytest.raises(ValueError, match="not a stiff-capable method"):
        SciPyIntegrator(method="RK45")


def test_radau_agrees_with_bdf() -> None:
    """Two independent stiff methods landing together is a real check."""
    bdf = simulate(full_system(), samples=60, integrator=SciPyIntegrator("BDF"))
    radau = simulate(full_system(), samples=60, integrator=SciPyIntegrator("Radau"))
    assert radau.converged
    assert radau.pressure("COPV")[-1] == pytest.approx(
        bdf.pressure("COPV")[-1], rel=1e-3
    )
    assert radau.vessel("TANK", "liquid_mass")[-1] == pytest.approx(
        bdf.vessel("TANK", "liquid_mass")[-1], rel=1e-3
    )


def test_a_failed_network_solve_reports_time_and_state() -> None:
    """A DAE failure without them is nearly undebuggable."""
    error = TransientError(1.25, {"COPV.mass": 2.5}, "the network solve failed")
    assert error.t == 1.25
    assert "1.25" in str(error)
    assert "COPV.mass" in str(error)
