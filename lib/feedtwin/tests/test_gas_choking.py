"""A valve on a gas line, at and past its critical pressure ratio.

Every vent and every press solenoid on a stand is a valve passing gas, and until
this existed none of them could choke: `Valve.choked_dp` is the IEC 60534 *liquid*
flashing model and returns None for a gas, so the base class reported no ceiling
and the incompressible Cv law ran unbounded. Measured on a 550 psi tank vented to
atmosphere, that was 2.5x to 5.5x the sonic mass flow depending on bore.

Below the choke a gas valve is IEC 60534-2-1 with its expansion factor too
(``feedtwin.comps.iec_gas.GasCv``): the incompressible law up to a separate
ceiling never met it, and the flow *fell* 36 % as the downstream did.
"""

from __future__ import annotations

import fluids.control_valve as cv_lib
import pytest

from feedtwin.comps import build_component, conditions_from_fluid
from feedtwin.comps.base import FlowConditions
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.props import Fluid
from feedtwin.solve.network import Network
from feedtwin.solve.steady import solve_steady

PSI = 6894.757293168361
R_UNIVERSAL_J = 8.31446261815324 * 1000.0  # CODATA, matching feedtwin.comps.base
KV_PER_CV = 1.0 / 1.1560992283536566

HELIUM = (4.0026, 1.667)
NITROGEN = (28.014, 1.40)


def valve(Cv: float, bore_mm: float, **params) -> object:
    fields = {
        "Cv": Param(Cv, "Cv", Provenance.ESTIMATED),
        "bore": Param(bore_mm, "mm", Provenance.MANUFACTURER),
    }
    fields.update(params)
    return build_component(ComponentInstance.build("V", "valve", fields, model="cv"))


def gas(mw: float, gamma: float, p_upstream: float, temperature: float):
    r_specific = R_UNIVERSAL_J / mw
    return FlowConditions(
        rho=p_upstream / (r_specific * temperature),
        mu=2.0e-5,
        p_upstream=p_upstream,
        temperature=temperature,
        gamma=gamma,
        r_specific=r_specific,
        # Priced as a gas, with the ideal-gas ratio IEC's F_gamma is built from
        # (conditions_from_fluid fills it for every gas-priced node).
        gamma_ideal=gamma,
    )


#: How close the library's IEC adapter sits to `fluids`' own implementation.
#: Constant at every drop and every gas: it is the scale alone, the Cv
#: definition (Cv_to_K) against IEC's tabulated N9, 0.112 %.
SCALE = 2e-3


def library_mdot(Cv, mw, gamma, p1, temperature, bore, p2=101325.0) -> float:
    """What `fluids` says the same valve passes at ``p2``. The reference.

    ``fluids`` takes Q as volume at **0 degC** and 1 atm (its docstring, and the
    N9 it uses). This reference used to read it at 15 degC, exactly as the
    valve's own calibration did -- so the two agreed to 1e-6 while both were
    5.4 % low.
    """
    r_specific = R_UNIVERSAL_J / mw
    rho_std = 101325.0 / (r_specific * 273.15)
    sized = cv_lib.size_control_valve_g(
        T=temperature,
        MW=mw,
        mu=2.0e-5,
        gamma=gamma,
        Z=1.0,
        P1=p1,
        P2=p2,
        Q=1.0,
        D1=bore,
        D2=bore,
        d=bore,
        allow_choked=True,
        full_output=True,
    )
    return rho_std * (Cv * KV_PER_CV) / sized["Kv"]


CASES = [
    ("helium 3/8in vent", 3.8, *HELIUM, 550 * PSI, 293.15, 0.00953),
    ("helium regulator", 1.6, *HELIUM, 4500 * PSI, 293.15, 0.00775),
    ("nitrogen 3/8in", 8.0, *NITROGEN, 1000 * PSI, 293.15, 0.00953),
    ("nitrogen cold 1/4in", 1.7, *NITROGEN, 200 * PSI, 250.0, 0.00635),
    ("helium 1in dump", 60.0, *HELIUM, 550 * PSI, 293.15, 0.0254),
]


@pytest.mark.parametrize("name,Cv,mw,gamma,p1,T,bore", CASES)
def test_the_ceiling_matches_the_library(name, Cv, mw, gamma, p1, T, bore) -> None:
    """Against `fluids`' own IEC 60534 implementation, not against arithmetic.

    The coefficient is calibrated from that library rather than transcribed,
    because the published N6 depends on which unit set *and* which flow
    coefficient the table is written for -- pairing N6 = 27.3 with Cv and kPa
    over-predicts by 10.5x, which is how this was first written.
    """
    got = valve(Cv, bore * 1000.0).flow_ceiling(gas(mw, gamma, p1, T))
    assert got == pytest.approx(library_mdot(Cv, mw, gamma, p1, T, bore), rel=SCALE)


def test_a_gas_vent_to_atmosphere_reports_choked() -> None:
    v, flow = valve(3.8, 9.53), gas(*HELIUM, 550 * PSI, 293.15)
    assert v.is_choked(550 * PSI - 101325.0, flow) is True


def test_a_small_pressure_ratio_is_not_choked() -> None:
    """Choking starts at x = (gamma/1.40) * xT, not at any drop."""
    v, flow = valve(3.8, 9.53), gas(*HELIUM, 550 * PSI, 293.15)
    assert v.is_choked(0.05 * 550 * PSI, flow) is False


def test_helium_and_nitrogen_choke_at_different_ratios() -> None:
    """F_gamma carries the specific-heat ratio; it is why the two gases differ."""
    dp = 0.75 * 550 * PSI
    assert valve(3.8, 9.53).is_choked(dp, gas(*NITROGEN, 550 * PSI, 293.15)) is True
    assert valve(3.8, 9.53).is_choked(dp, gas(*HELIUM, 550 * PSI, 293.15)) is False


def test_a_liquid_valve_still_has_no_gas_ceiling() -> None:
    """LOX through a main valve must not acquire a sonic limit."""
    liquid = FlowConditions(
        rho=1141.0, mu=1.9e-4, p_upstream=550 * PSI, temperature=90.0
    )
    assert valve(26.1, 12.7).flow_ceiling(liquid) is None


#: R037, deferred: a network-priced liquid still carries the old gas ceiling,
#: because removing it lets a drawing with no engine model empty its LOX tank in
#: the coupling step the session holds the chamber at ambient (see
#: feedtwin.comps.elements._CHOKE_COEFFICIENT). Strict: these turn red when the
#: session closes that chamber and the ceiling goes, and must then be unmarked.
R037_DEFERRED = pytest.mark.xfail(
    strict=True, reason="R037 deferred: liquids keep the old gas ceiling"
)


@R037_DEFERRED
@pytest.mark.parametrize(
    "species,T", [("oxygen", 90.2), ("ethanol", 293.0)], ids=["LOX", "ethanol"]
)
def test_a_liquid_priced_by_the_network_has_no_gas_ceiling(
    species: str, T: float
) -> None:
    """The conditions a network builds for a liquid carry the saturated
    liquid's cp/cv (LOX 1.83, ethanol 1.19), and the old gas test (gamma > 0)
    read that as a gas: every liquid valve got a sonic ceiling at
    x = gamma/1.4 * 0.7, and a LOX dump to atmosphere drained at 0.69x IEC."""
    flow = conditions_from_fluid(Fluid(species), 300 * PSI, T)
    assert flow.gamma > 0.0, "the trap: a liquid's cp/cv is positive too"
    v = valve(1.0, 9.5)
    assert v.flow_ceiling(flow) is None
    assert not v.is_choked(0.99 * 300 * PSI, flow) or v.choked_dp(flow) is not None


@R037_DEFERRED
@pytest.mark.parametrize(
    "species,T,p1_psia",
    [("oxygen", 90.2, 300.0), ("oxygen", 90.2, 600.0), ("ethanol", 293.0, 600.0)],
)
def test_a_liquid_valve_to_atmosphere_is_the_iec_liquid_law(
    species: str, T: float, p1_psia: float
) -> None:
    """Solved through a network, a Cv 1 valve discharging liquid to atmosphere
    passes what fluids' IEC 60534 liquid sizing gives for the same drop
    (non-choked form: the incompressible law is the one the twin solves; the
    IEC liquid choke is reported by ``choked_dp``, not imposed)."""
    p1 = p1_psia * PSI
    net = Network()
    net.add_node("tank", species, T, pressure=p1)
    net.add_node("atm", species, T, pressure=101325.0)
    for node in net.nodes.values():
        node.phase = "liquid"
    net.add_branch("V", valve(1.0, 9.5), "tank", "atm")  # type: ignore[arg-type]
    result = solve_steady(net)
    assert result.converged
    flow = conditions_from_fluid(Fluid(species), p1, T)
    Q = 1e-3
    kv = cv_lib.size_control_valve_l(
        rho=flow.rho,
        Psat=flow.p_sat,
        Pc=flow.p_crit,
        mu=flow.mu,
        P1=p1,
        P2=101325.0,
        Q=Q,
        D1=0.0095,
        D2=0.0095,
        d=0.0095,
        allow_choked=False,
    )
    expected = flow.rho * Q * KV_PER_CV / kv
    assert result.flows["V"] == pytest.approx(expected, rel=SCALE)


def _swept(p1: float, p2: float, Cv: float = 4.0) -> float:
    """A Cv 4 valve between two fixed nitrogen pressures, solved."""
    net = Network()
    net.add_node("up", "nitrogen", 293.0, pressure=p1)
    net.add_node("dn", "nitrogen", 293.0, pressure=p2)
    for node in net.nodes.values():
        node.phase = "gas"
    net.add_branch("V", valve(Cv, 9.5), "up", "dn")  # type: ignore[arg-type]
    result = solve_steady(net)
    assert result.converged
    return result.flows["V"]


def test_gas_flow_rises_continuously_to_the_choke_and_stays() -> None:
    """IEC 60534-2-1: W = N6 C Y sqrt(x p1 rho1), Y = 1 - x/(3 F_gamma xT).

    The plain valve used Y = 1 below a separately calibrated ceiling: at
    500 psia, 140 psia downstream it passed 0.956 kg/s (IEC 0.628, 1.52x), and
    at 130 psia 0.609 -- flow *falling* 36 % as the downstream fell 10 psi.
    """
    p1 = 500 * PSI
    downstream = [450, 400, 300, 200, 160, 150, 145, 140, 135, 130, 120, 100, 14.7]
    flows = [_swept(p1, p2 * PSI) for p2 in downstream]
    for before, after in zip(flows, flows[1:]):
        assert after >= before * (1.0 - 1e-9), "flow must not fall as dp rises"
    for p2, flow in zip(downstream, flows):
        reference = library_mdot(4.0, *NITROGEN, p1, 293.0, 0.0095, p2=p2 * PSI)
        # Real nitrogen (Z ~ 1.0) against fluids' ideal gas (Z = 1): Z enters
        # IEC's sqrt(x p1 rho1) through rho1, a few tenths of a percent here.
        z = conditions_from_fluid(Fluid("nitrogen"), p1, 293.0, phase="gas").rho
        ideal = p1 / (R_UNIVERSAL_J / NITROGEN[0] * 293.0)
        assert flow == pytest.approx(reference * (z / ideal) ** 0.5, rel=SCALE), p2


def test_a_choked_gas_valve_meets_its_ceiling_continuously() -> None:
    """Just under the critical ratio the flow is within a hair of the ceiling;
    the old law was 50 % above it there."""
    p1 = 500 * PSI
    flow = conditions_from_fluid(Fluid("nitrogen"), p1, 293.0, phase="gas")
    v = valve(4.0, 9.5)
    ceiling = v.flow_ceiling(flow)
    x_crit = (flow.gamma_ideal / 1.40) * 0.7
    near = _swept(p1, p1 * (1.0 - 0.999 * x_crit))
    assert near == pytest.approx(ceiling, rel=1e-5)
    assert near <= ceiling


def test_a_shut_valve_has_no_ceiling() -> None:
    """Nothing flows, so there is nothing to limit -- and a zero ceiling would
    pin the branch at zero rather than let `isolates()` remove it."""
    v = valve(3.8, 9.53, leak_closed=Param(0.0, "Cv", Provenance.ESTIMATED))
    flow = gas(*HELIUM, 550 * PSI, 293.15)
    object.__setattr__(flow, "signals", {"V.command": 0.0})
    assert v.flow_ceiling(flow) is None


def test_xT_moves_the_ceiling() -> None:
    """A butterfly (xT ~ 0.3) chokes lower and passes less than a globe."""
    flow = gas(*HELIUM, 550 * PSI, 293.15)
    globe = valve(3.8, 9.53).flow_ceiling(flow)
    butterfly = valve(
        3.8, 9.53, xT=Param(0.3, "-", Provenance.MANUFACTURER)
    ).flow_ceiling(flow)
    assert butterfly < globe
