"""Closed forms Layer X's physics must reproduce, through the components it actually burns with.

Each test sets up a case with a textbook answer, runs it through lib/feedtwin (or EngineDesign's
chamber solve and the Layer X engine card), and compares with the formula written out here. Each
was shown to fail when its formula is broken in the code (see the mutation notes in each docstring).

What lib/feedtwin already checks, and is not repeated here:

* ``tests/test_vessels.py::test_adiabatic_blowdown_matches_the_closed_form``: a vessel emptied at a
  *prescribed* flow follows T/T0 = (m/m0)^(g-1). Here the flow is the choked orifice's own, so the
  time history checks the orifice and the vessel together.
* ``tests/test_comps_validation.py::test_orifice_cd_inverts_the_bernoulli_relation``: the orifice
  component alone. Here it is solved inside a network between two pressures.
* ``tests/test_body_acceleration.py``: a pipe's static head and a session's tank head at 7 g. Here the
  network solve itself must balance a column at a non-standard specific force.
* ``tests/test_engine_card.py::test_card_chamber_pressure_and_thrust_follow_the_tables``: a constant
  card's Pc. Here the card is fitted to the LE4 engine and checked against EngineDesign's closure,
  whose Rayleigh stagnation loss is worked out by hand.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

feedtwin = pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed (pip install -e ../lib/feedtwin)")

from feedtwin.comps import build_component, conditions_from_fluid  # noqa: E402
from feedtwin.model import ComponentInstance, Param, Provenance  # noqa: E402
from feedtwin.props import Fluid  # noqa: E402
from feedtwin.solve import Network, solve_steady  # noqa: E402
from feedtwin.vessels import GasVolume  # noqa: E402

M = Provenance.MANUFACTURER
G0 = 9.80665
PSI = 6894.757293168361
BASELINE = Path(__file__).resolve().parents[1] / "docs" / "layerx" / "baseline-2026-10-02.json"


# ---------------------------------------------------------------- choked blowdown


def _choked_blowdown(gas: str, isothermal: bool, duration: float, steps: int = 4000, *, V: float = 0.05,
                     p0: float = 2.0e5, T0: float = 300.0, bore: float = 2.0e-3, cd: float = 0.85):
    """A vessel emptied through a choked gas orifice into vacuum: feedtwin's ``gas_orifice`` sets the
    flow from the vessel's state at every step. ``isothermal``: the vessel wears a wall of effectively
    infinite heat capacity, coupled tightly (500 W/K against ~80 J/K of gas), which holds the gas at
    its temperature; otherwise the vessel has no wall and the expansion is adiabatic."""
    fl = Fluid(gas)
    orifice = build_component(ComponentInstance.build(
        "GO-01", "gas_orifice", {"bore": Param(bore * 1e3, "mm", M, "test"), "Cd": Param(cd, "-", M, "test")}))
    vessel = (GasVolume(fl, volume=V, wall_mass=1.0e7, wall_capacity=900.0, wall_conductance=500.0) if isothermal
              else GasVolume(fl, volume=V))
    start = vessel.initial_state(pressure=p0, temperature=T0)

    def mdot(state, t):  # noqa: ARG001 - the blowdown's callable signature
        return orifice.choked_flow(conditions_from_fluid(fl, vessel.pressure(state), vessel.temperature(state)))  # type: ignore[attr-defined]

    history = vessel.blowdown(start, mdot, duration=duration, steps=steps)
    c0 = conditions_from_fluid(fl, p0, T0)
    g, R = c0.gamma, c0.r_specific
    # mdot = Cd A p sqrt(g/(R T)) (2/(g+1))^((g+1)/(2(g-1))) (Sutton & Biblarz, Rocket Propulsion
    # Elements, 9th ed., eq. 3-24); with m = pV/(RT):
    #   isothermal: p/p0 = exp(-t/tau);
    #   adiabatic:  p/p0 = (1 + (g-1)/2 t/tau)^(-2g/(g-1)),
    # tau = V / (Cd A (2/(g+1))^((g+1)/(2(g-1))) sqrt(g R T0)), integrating dp/dt with T = T0 (p/p0)^((g-1)/g).
    area = math.pi * bore * bore / 4.0
    tau = V / (cd * area * (2.0 / (g + 1.0)) ** ((g + 1.0) / (2.0 * (g - 1.0))) * math.sqrt(g * R * T0))
    out = []
    for t, state in history[:: max(len(history) // 25, 1)]:
        closed = math.exp(-t / tau) if isothermal else (1.0 + 0.5 * (g - 1.0) * t / tau) ** (-2.0 * g / (g - 1.0))
        out.append((t, vessel.pressure(state) / p0, closed))
    return out, tau


@pytest.mark.parametrize("gas,isothermal,duration", [
    ("nitrogen", True, 110.0),
    ("nitrogen", False, 110.0),
    ("helium", False, 15.0),
])
def test_a_choked_blowdown_follows_its_closed_form(gas, isothermal, duration):
    """At two bar both gases are ideal to ~0.05 % (the reference's premise); the residual is that and
    the change of the real gamma with temperature, ~0.3 % at most by p/p0 = 0.2. Mutation: scaling
    ``feedtwin.comps.gas.choked_mass_flow`` by 1.02 (or dropping its sqrt(gamma)) fails this."""
    rows, tau = _choked_blowdown(gas, isothermal, duration)
    assert rows[-1][1] < 0.6, "the blowdown must get well away from its start to test anything"
    for t, model, closed in rows:
        assert model == pytest.approx(closed, rel=4e-3), f"{gas} at t={t:.2f} s (tau {tau:.1f} s)"


def test_the_isothermal_and_adiabatic_bounds_bracket_a_real_wall():
    """Physical ordering, not a closed form: a wall that exchanges heat keeps the gas warmer than
    adiabatic and cooler than isothermal, so its pressure lies between the two closed forms."""
    rows_a, _ = _choked_blowdown("nitrogen", False, 60.0, steps=2000)
    rows_i, _ = _choked_blowdown("nitrogen", True, 60.0, steps=2000)
    assert rows_a[-1][1] < rows_i[-1][1]
    assert rows_a[-1][2] < rows_i[-1][2]


# ---------------------------------------------------------------- orifice in a network


@pytest.mark.parametrize("dp_bar,cd,bore_mm", [(4.0, 0.61, 2.0), (25.0, 0.80, 1.5)])
def test_a_network_solves_an_orifice_to_cd_a_sqrt_2_rho_dp(dp_bar, cd, bore_mm):
    """``mdot = Cd A sqrt(2 rho dp)`` for an incompressible liquid through a sharp orifice between two
    held pressures (Sutton & Biblarz eq. 8-1). Mutation: dropping the 2 in ``OrificeCd`` fails this."""
    orifice = build_component(ComponentInstance.build(
        "OR-01", "orifice", {"bore": Param(bore_mm, "mm", M, "test"), "pipe_bore": Param(10.92, "mm", M, "line"),
                             "Cd": Param(cd, "-", M, "test")}, model="cd"))
    net = Network()
    p_up = 5.0e5 + dp_bar * 1e5
    net.add_node("up", "water", 293.15, pressure=p_up)
    net.add_node("dn", "water", 293.15, pressure=5.0e5)
    net.add_branch("OR-01", orifice, "up", "dn")  # type: ignore[arg-type]
    result = solve_steady(net)
    assert result.converged
    rho = net.conditions("up", p_up).rho
    area = math.pi * (bore_mm * 1e-3) ** 2 / 4.0
    assert result.flows["OR-01"] == pytest.approx(cd * area * math.sqrt(2.0 * rho * dp_bar * 1e5), rel=1e-7)


# ---------------------------------------------------------------- hydrostatic head


def _column(gravity: float, dp: float, climb: float = 1.3716):
    """Ethanol in a vertical 1/2 in x 0.035 in line, ``climb`` metres high (the team's 4.5 ft fuel
    run), held at the bottom and ``dp`` lower at the top."""
    pipe = build_component(ComponentInstance.build("FL-01", "pipe", {
        "length": Param(climb, "m", M, "test"), "bore": Param(10.92, "mm", M, "1/2 x 0.035 in tube"),
        "elevation_change": Param(climb, "m", M, "test")}))
    net = Network()
    net.gravity = gravity
    net.add_node("bottom", "ethanol", 293.15, pressure=40.0e5)
    rho = net.conditions("bottom", 40.0e5).rho
    net.add_node("top", "ethanol", 293.15, pressure=40.0e5 - dp(rho) if callable(dp) else 40.0e5 - dp)
    net.add_branch("FL-01", pipe, "bottom", "top")  # type: ignore[arg-type]
    return solve_steady(net), rho


LIFTOFF = 8.25 * G0
"""The specific force at LE4's liftoff, 8.25 g0 (AUDIT 5.1: T/m at the first flown step)."""


def test_a_column_at_a_known_specific_force_holds_exactly_rho_a_h():
    """``dp = rho a h`` (hydrostatics in the vehicle frame, a the specific force along the axis). Held
    at exactly that difference, the column does not move; held at the pad's rho g0 h under the same
    specific force, it falls. Mutation: a pipe whose static head uses standard gravity fails this."""
    h = 1.3716
    still, rho = _column(LIFTOFF, lambda r: r * LIFTOFF * h)
    assert still.converged
    assert abs(still.flows["FL-01"]) < 1e-6
    pad, _ = _column(LIFTOFF, lambda r: r * G0 * h)
    assert pad.converged and pad.flows["FL-01"] < -0.1, "under 8.25 g the pad's head cannot hold the column up"
    # The density the head is priced at: the twin takes liquid on the saturation line at its
    # temperature (CoolProp: 789.34 kg/m^3 for ethanol at 293.15 K), not compressed to the 40 bar it is
    # held at (792.81 kg/m^3, +0.44 %). So the extra head at liftoff is 789.34 * 7.25 g0 * 1.3716 m =
    # 11.164 psi, not 11.213. This pins that choice; the balance above is the physics check.
    CP = pytest.importorskip("CoolProp.CoolProp")
    assert rho == pytest.approx(CP.PropsSI("D", "T", 293.15, "Q", 0, "Ethanol"), rel=1e-4)
    assert rho * (LIFTOFF - G0) * h / PSI == pytest.approx(11.164, abs=0.002)


# ---------------------------------------------------------------- Pc = mdot c* / A_t


def _rayleigh_kappa(contraction: float, gamma: float) -> float:
    """``P_injector_end / P0_nozzle`` of a constant-area combustor (heat added along a Rayleigh line):
    ``(1 + g M^2) / (1 + (g-1)/2 M^2)^(g/(g-1))`` with ``M`` the chamber-end Mach number on the
    subsonic branch of ``A/A* = (1/M) [(2/(g+1)) (1 + (g-1)/2 M^2)]^((g+1)/(2(g-1)))`` (Sutton &
    Biblarz, 9th ed., sec. 3.3 and Table 3-2; Huzel & Huang, sec. 2). Solved here by bisection."""
    g = gamma

    def area_ratio(m: float) -> float:
        return (1.0 / m) * ((2.0 / (g + 1.0)) * (1.0 + 0.5 * (g - 1.0) * m * m)) ** ((g + 1.0) / (2.0 * (g - 1.0)))

    lo, hi = 1e-9, 1.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        lo, hi = (mid, hi) if area_ratio(mid) > contraction else (lo, mid)
    m = 0.5 * (lo + hi)
    return (1.0 + g * m * m) / (1.0 + 0.5 * (g - 1.0) * m * m) ** (g / (g - 1.0))


@pytest.fixture(scope="module")
def le4_point():
    if not BASELINE.is_file():
        pytest.skip("the LE4 baseline (docs/layerx/baseline-2026-10-02.json) is not in this checkout")
    from engine.layerx.card import EngineSampler
    from engine.pipeline.config_schemas import PintleEngineConfig

    config = PintleEngineConfig(**json.loads(BASELINE.read_text())["inputs"]["config"])
    ambient = 94069.72225005485                      # the site's atmosphere at 626.67 m (derived.ambient_pa)
    sampler = EngineSampler(config, ambient)
    p_O, p_F = 560.0 * PSI, 545.0 * PSI              # line-exit pressures inside LE4's burn (AUDIT 9.9 B)
    res = sampler.runner.evaluate(p_O, p_F, silent=True, P_ambient=ambient)
    return sampler, res, (p_O, p_F), ambient


def test_enginedesign_closes_its_chamber_on_mdot_cstar_over_At_with_the_rayleigh_loss(le4_point):
    """``Pc = kappa mdot c*/A_t``: c* = eta_c* c*_ideal is referred to the nozzle's stagnation
    pressure, and Pc is the injector end, kappa = 1.004 above it on LE4 (contraction 7.06). Mutation:
    EngineDesign's ``nozzle_stagnation_loss`` returning 1.0 fails this by 0.4 %."""
    sampler, res, _, _ = le4_point
    cg = sampler.config.chamber_geometry
    contraction = math.pi * cg.chamber_diameter ** 2 / 4.0 / cg.A_throat
    kappa = _rayleigh_kappa(contraction, float(res["gamma"]))
    mdot = res["mdot_O"] + res["mdot_F"]
    assert 1.002 < kappa < 1.01
    assert res["Pc"] == pytest.approx(kappa * mdot * res["cstar_actual"] / cg.A_throat, rel=1e-8)
    assert res["cstar_actual"] == pytest.approx(res["eta_cstar"] * res["cstar_ideal"], rel=1e-12)


def test_the_engine_card_returns_enginedesigns_pc_at_a_fixed_point(le4_point):
    """The Layer X card stores c*_card = Pc A_t / mdot (the injector-end c*), so its chamber returns
    ``Pc = mdot c*_card / A_t`` = EngineDesign's Pc at a point it was fitted through, to the table's
    interpolation error. Mutation: the card chamber's Pc without the 1/A_t, or c* scaled, fails this."""
    from engine.layerx.card import fit_card

    sampler, res, (p_O, p_F), ambient = le4_point
    samples = []
    for u in (0.95, 1.0, 1.05):
        for v in (0.95, 1.0, 1.05):
            point = sampler(p_O * u, p_O * u * v * (p_F / p_O))
            if point is not None:
                samples.append({**point, "p_O": p_O * u, "p_F": p_O * u * v * (p_F / p_O)})
    assert len(samples) == 9
    cg = sampler.config.chamber_geometry
    card = fit_card(samples, throat_area=float(cg.A_throat), exit_area=float(cg.A_exit), ambient_pa=ambient,
                    name="LE4 fixed point")
    out = card.chamber_model(ambient_pressure=ambient).evaluate(res["mdot_O"], res["mdot_F"])
    mdot = res["mdot_O"] + res["mdot_F"]
    cg_kappa = _rayleigh_kappa(math.pi * cg.chamber_diameter ** 2 / 4.0 / cg.A_throat, float(res["gamma"]))
    assert out.pressure == pytest.approx(res["Pc"], rel=1e-5)
    assert out.pressure == pytest.approx(cg_kappa * mdot * res["cstar_actual"] / cg.A_throat, rel=1e-5)
