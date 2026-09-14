"""The still-gas film, checked against the correlation it adapts."""

from __future__ import annotations

import math

import pytest
from ht import Nu_vertical_plate_Churchill

from feedtwin.props import Fluid
from feedtwin.vessels.convection import still_gas_conductance

PSI = 6894.757293168361


def test_matches_a_hand_calculation_through_ht() -> None:
    """The function is the correlation applied to CoolProp's numbers and the
    vessel's area, nothing more. Redo it by hand."""
    gas = Fluid("nitrogen")
    p, T, L, A, dT = 500.0 * PSI, 293.15, 0.5, 0.6, 10.0
    film = still_gas_conductance(gas, p, T, L, A, dT)

    rho = gas.get("rho", p=p, T=T)
    mu = gas.get("mu", p=p, T=T)
    k = gas.get("k", p=p, T=T)
    cp = gas.get("cp", p=p, T=T)
    gr = 9.80665 * (1.0 / T) * dT * L**3 / (mu / rho) ** 2
    pr = cp * mu / k
    nu = Nu_vertical_plate_Churchill(pr, gr)
    assert film.grashof == pytest.approx(gr)
    assert film.prandtl == pytest.approx(pr)
    assert film.nusselt == pytest.approx(nu)
    assert film.hA == pytest.approx(nu * k / L * A)


def test_lands_in_the_band_the_old_default_stood_in() -> None:
    """The shipped default for a 17.5 L tank was 12 W/K, scaled as V^(2/3).
    A nitrogen ullage at 500 psi against a wall of that size should come out
    the same order -- not a tenth, not ten times."""
    gas = Fluid("nitrogen")
    film = still_gas_conductance(gas, 500.0 * PSI, 293.15, 0.45, 0.45, 10.0)
    assert 3.0 < film.hA < 60.0


def test_denser_gas_convects_harder() -> None:
    """Grashof goes as density squared, so the same tank at a higher pressure
    has a stiffer film. Which is the point of deriving it from the gas."""
    gas = Fluid("nitrogen")
    low = still_gas_conductance(gas, 100.0 * PSI, 293.15, 0.45, 0.45, 10.0)
    high = still_gas_conductance(gas, 1000.0 * PSI, 293.15, 0.45, 0.45, 10.0)
    assert high.hA > low.hA


def test_helium_and_nitrogen_differ() -> None:
    """Same tank, same pressure, different gas: the number is the gas's."""
    n2 = still_gas_conductance(Fluid("nitrogen"), 500.0 * PSI, 293.15, 0.45, 0.45)
    he = still_gas_conductance(Fluid("helium"), 500.0 * PSI, 293.15, 0.45, 0.45)
    assert not math.isclose(n2.hA, he.hA, rel_tol=0.05)


def test_refuses_nonsense() -> None:
    with pytest.raises(ValueError):
        still_gas_conductance(Fluid("nitrogen"), 0.0, 293.15, 0.45, 0.45)
