"""The tables are not trusted near the saturation line (``backends.coolprop._Dome``).

CoolProp's bicubic tables interpolate across the saturation line wherever a
table cell straddles it. Measured against the equation of state (HEOS), on
CoolProp 7.2 and 8.0: nitrogen ten kelvin above its boiling point at 1.07 bar
read 83 kg/m^3 for 4.3; saturated oxygen vapour at 90 K read 0.47 bar for
0.99 -- the partial pressure a cold LOX ullage is built from. Near the line the
tables now decline and the chain's HEOS answers; away from it nothing changes.
These are checked against CoolProp's HEOS directly, not against feedtwin.
"""

from __future__ import annotations

import CoolProp.CoolProp as CP
import pytest

from feedtwin.props import Fluid

N2 = Fluid("nitrogen")
O2 = Fluid("oxygen")


@pytest.mark.parametrize("above_K", [0.5, 2.0, 5.0, 10.0])
def test_cold_nitrogen_near_an_atmosphere_is_a_gas(above_K: float) -> None:
    p = 107613.0
    T = CP.PropsSI("T", "P", p, "Q", 1, "Nitrogen") + above_K
    assert N2.get("rho", p=p, T=T) == pytest.approx(
        CP.PropsSI("D", "P", p, "T", T, "Nitrogen"), rel=1e-3
    )


@pytest.mark.parametrize("T", [90.0, 110.0, 140.0])
def test_saturated_oxygen_vapour_has_its_own_pressure(T: float) -> None:
    rho = CP.PropsSI("D", "T", T, "Q", 1, "Oxygen")
    assert O2.get("p", rho=rho, T=T) == pytest.approx(
        CP.PropsSI("P", "D", rho, "T", T, "Oxygen"), rel=1e-3
    )


def test_a_vent_gas_temperature_from_its_enthalpy() -> None:
    p = 2.2e5
    T = CP.PropsSI("T", "P", p, "Q", 1, "Nitrogen") + 1.0
    h = CP.PropsSI("H", "P", p, "T", T, "Nitrogen")
    assert N2.get("T", p=p, h=h) == pytest.approx(T, abs=0.02)


def test_away_from_the_line_the_tables_still_answer() -> None:
    """The guard costs nothing where the tables are good: warm pressurant and
    subcooled LOX at tank pressure stay on the fast backend."""
    assert N2.state(p=3.0e7, T=293.15).backend == "bicubic"
    assert O2.state(p=3.7e6, T=90.0).backend == "bicubic"
    assert N2.state(p=107613.0, T=82.0).backend == "heos"
