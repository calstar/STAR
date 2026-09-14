"""Does the property layer produce physically right numbers?

Phase 01's exit criterion, and the only part of it that catches the failure
that matters: a plumbing bug that returns *a* number rather than *the* number.
Everything here is checked against values from outside this codebase.

Three kinds of check, because each catches something the others cannot:

* **Saturation and single-phase points** against standard reference values.
  Loose tolerances -- these are literature figures, not this package's output --
  but they would catch a wrong species mapping, a unit error, or a molar/mass
  basis mix-up instantly.
* **Critical points**, tightly. They are constants of the equation of state, so
  the only way they move is if a species now resolves to a different fluid.
* **Cross-backend agreement.** Interpolated tables must reproduce the equation
  of state they were built from. This is the one that catches a corrupt or
  stale table cache, and it is the check with no external reference at all --
  it asks only that the two paths agree.

Note that these are *reference* points, not a validation campaign. Agreeing
with CoolProp is not evidence that CoolProp is right; it is evidence that this
package is asking it correctly. Physical validation against measured hardware
data is Phase 12, and cannot start until there is measured hardware data.
"""

from __future__ import annotations

import pytest

from feedtwin.props import Fluid, Phase

#: Saturated liquid at one standard atmosphere, from standard references.
#: (fluid, T_sat [K], rho_liquid [kg/m3]) -- 0.5% tolerance, which is wider
#: than the equation of state and narrower than any plausible bug.
NORMAL_BOILING = [
    ("nitrogen", 77.355, 806.1),
    ("oxygen", 90.188, 1141.2),
    ("ethanol", 351.57, 736.4),
    ("helium", 4.224, 124.7),
]

#: Critical points -- constants of the equation of state.
#: (fluid, Tc [K], Pc [MPa]). Temperature is pinned tighter than pressure
#: because reference sources agree on it more closely.
CRITICAL_POINTS = [
    ("nitrogen", 126.192, 3.3958),
    ("oxygen", 154.599, 5.0464),
    ("ethanol", 514.71, 6.268),
    ("helium", 5.195, 0.2283),
    ("methane", 190.564, 4.5992),
]

ATM = 101325.0


@pytest.mark.parametrize("name,T_sat,rho_liquid", NORMAL_BOILING)
def test_normal_boiling_point(name: str, T_sat: float, rho_liquid: float) -> None:
    """Saturation temperature and liquid density at 1 atm."""
    fluid = Fluid(name)
    state = fluid.state(p=ATM, q=0.0)

    assert state.T == pytest.approx(T_sat, rel=5e-3)
    assert state.rho == pytest.approx(rho_liquid, rel=5e-3)
    assert state.phase is Phase.TWO_PHASE
    assert state.quality == pytest.approx(0.0, abs=1e-9)


@pytest.mark.parametrize("name,Tc,Pc_MPa", CRITICAL_POINTS)
def test_critical_point(name: str, Tc: float, Pc_MPa: float) -> None:
    """The species resolves to the fluid we think it does.

    Read through CoolProp's trivial-property interface rather than a state
    query, because the critical point is a property of the substance and not of
    any state point.
    """
    import CoolProp.CoolProp as CP

    backend_fluid = Fluid(name).species.backend_fluid
    assert CP.PropsSI("Tcrit", backend_fluid) == pytest.approx(Tc, rel=1e-4)
    assert CP.PropsSI("Pcrit", backend_fluid) == pytest.approx(Pc_MPa * 1e6, rel=5e-3)


def test_ethanol_density_at_room_temperature() -> None:
    """Liquid ethanol at 20 C, 1 atm: about 789 kg/m3.

    The one fluid here whose density most people can check by eye, which is
    exactly why it is worth pinning -- a mass/molar basis error would show up
    as roughly 46x, not as a subtle drift.
    """
    assert Fluid("ethanol").get("rho", p=ATM, T=293.15) == pytest.approx(
        789.4, rel=5e-3
    )


@pytest.mark.parametrize("name,expected_Z", [("nitrogen", 1.1506), ("helium", 1.1460)])
def test_copv_is_not_an_ideal_gas(name: str, expected_Z: float) -> None:
    """Z at a 4500 psi COPV, 293.15 K -- roughly 15% off ideal for both gases.

    This is the number that justifies a real-gas property layer existing at
    all. An ideal-gas COPV model over-predicts stored pressurant mass by about
    15%, which propagates straight into how long the tanks stay pressurised.
    """
    Z = Fluid(name).get("Z", p=3.103e7, T=293.15)
    assert Z == pytest.approx(expected_Z, rel=1e-3)
    assert Z > 1.10, "both pressurants are strongly non-ideal at COPV pressure"


def test_compressibility_matches_the_equation_of_state() -> None:
    """Derived Z agrees with CoolProp's own, on the backend that implements it.

    Z is computed here as p/(rho.R_specific.T) because the tabulated backend
    does not implement ``compressibility_factor``. Deriving it is only
    legitimate if it reproduces the real thing.
    """
    import CoolProp.CoolProp as CP

    state = CP.AbstractState("HEOS", "Nitrogen")
    state.update(CP.PT_INPUTS, 3.103e7, 293.15)

    derived = Fluid("nitrogen", chain=["heos"]).get("Z", p=3.103e7, T=293.15)
    assert derived == pytest.approx(state.compressibility_factor(), rel=1e-5)


@pytest.mark.parametrize("name", ["nitrogen", "oxygen", "ethanol", "helium"])
@pytest.mark.parametrize("prop", ["rho", "mu", "k", "cp", "a", "h"])
def test_tables_reproduce_the_equation_of_state(name: str, prop: str) -> None:
    """Interpolated tables agree with the equation of state behind them.

    The check with no external reference: it does not ask whether either path
    is right, only that they are the same. That is what catches a stale table
    cache after a CoolProp upgrade -- a failure mode with no other symptom,
    because both paths keep returning confident numbers.

    1e-3 relative: bicubic interpolation error, not agreement to machine
    precision, which tables cannot give.
    """
    fast = Fluid(name, chain=["bicubic"])
    exact = Fluid(name, chain=["heos"])

    # A state point comfortably inside the tables for every fluid here:
    # supercritical for the cryogens, compressed liquid for ethanol.
    p, T = 2.0e6, 320.0
    assert fast.get(prop, p=p, T=T) == pytest.approx(
        exact.get(prop, p=p, T=T), rel=1e-3
    )


def test_gamma_and_kinematic_viscosity_are_consistent() -> None:
    """Derived quantities agree with the fields they are derived from."""
    state = Fluid("nitrogen").state(p=1.0e6, T=300.0)
    assert state.gamma == pytest.approx(state.cp / state.cv, rel=1e-12)
    assert state.nu == pytest.approx(state.mu / state.rho, rel=1e-12)
    assert 1.3 < state.gamma < 1.5, "diatomic gas near room temperature"
