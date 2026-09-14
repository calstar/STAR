"""A valve on a gas line, at and past its critical pressure ratio.

Every vent and every press solenoid on a stand is a valve passing gas, and until
this existed none of them could choke: `Valve.choked_dp` is the IEC 60534 *liquid*
flashing model and returns None for a gas, so the base class reported no ceiling
and the incompressible Cv law ran unbounded. Measured on a 550 psi tank vented to
atmosphere, that was 2.5x to 5.5x the sonic mass flow depending on bore.
"""

from __future__ import annotations

import fluids.control_valve as cv_lib
import pytest

from feedtwin.comps import build_component
from feedtwin.comps.base import FlowConditions
from feedtwin.model import ComponentInstance, Param, Provenance

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
    )


def library_choked_mdot(Cv, mw, gamma, p1, temperature, bore) -> float:
    """What `fluids` says the same valve passes, choked. The reference."""
    r_specific = R_UNIVERSAL_J / mw
    rho_std = 101325.0 / (r_specific * 288.15)
    sized = cv_lib.size_control_valve_g(
        T=temperature,
        MW=mw,
        mu=2.0e-5,
        gamma=gamma,
        Z=1.0,
        P1=p1,
        P2=101325.0,
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
    assert got == pytest.approx(
        library_choked_mdot(Cv, mw, gamma, p1, T, bore), rel=1e-6
    )


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
