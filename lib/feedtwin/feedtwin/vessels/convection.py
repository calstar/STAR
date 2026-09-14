"""Still-gas conductance between an ullage and its wall, from the gas.

A vessel's ``wall_conductance`` (hA, W/K) used to be a number somebody typed,
or a per-litre default scaled by area. It is neither a material property nor
a number a person on the stand knows. It is the gas: a helium ullage and a
nitrogen ullage at the same pressure sit against the same wall with different
conductivity, viscosity and density, and natural convection in an enclosed
gas is what sets the film.

So it is estimated here from the gas and the vessel, with the correlation
adapted from ``ht`` rather than written down: Churchill–Chu for a vertical
isothermal surface, which a tank wall is to within its curvature. The
temperature difference driving the convection is not known ahead of a run,
so it is an argument, stated, and the caller reports it as an assumption.

Nothing here is applied unless a drawing leaves the field blank and the
caller asks. The library's default stays what it was.
"""

from __future__ import annotations

from dataclasses import dataclass

from ht import Nu_vertical_plate_Churchill

from feedtwin.props import Fluid

G = 9.80665


@dataclass(frozen=True, slots=True)
class GasFilm:
    """What the estimate was made from, so a report can print it."""

    hA: float
    """Conductance [W/K]."""
    h: float
    """Film coefficient [W/(m^2.K)]."""
    area: float
    """Inner surface used [m^2]."""
    grashof: float
    prandtl: float
    nusselt: float
    delta_T: float
    """The gas-to-wall temperature difference assumed [K]."""


def still_gas_conductance(
    gas: Fluid,
    pressure: float,
    temperature: float,
    height: float,
    area: float,
    delta_T: float = 10.0,
) -> GasFilm:
    """hA for a still gas against a vertical wall of this height and area.

    Args:
        gas: The ullage gas.
        pressure: Gas pressure [Pa], absolute. Density goes as p, and the
            Grashof number as density squared, so this matters.
        temperature: Gas film temperature [K].
        height: Height of the wall the gas convects along [m].
        area: Inner surface in contact with the gas [m^2].
        delta_T: Gas-to-wall difference the film is evaluated at [K]. Natural
            convection stiffens with it as ``dT^(1/4)`` or so; ten kelvin is a
            blowdown in progress, and is what the caller states.
    """
    if pressure <= 0.0 or temperature <= 0.0 or height <= 0.0 or area <= 0.0:
        raise ValueError("pressure, temperature, height and area must be positive")
    dT = max(delta_T, 1e-3)
    rho = gas.get("rho", p=pressure, T=temperature)
    mu = gas.get("mu", p=pressure, T=temperature)
    k = gas.get("k", p=pressure, T=temperature)
    cp = gas.get("cp", p=pressure, T=temperature)
    nu = mu / rho
    # Ideal-gas expansivity; the ullage gases are near enough ideal at these
    # states for a film estimate, and CoolProp's own beta is not in the
    # property registry.
    beta = 1.0 / temperature
    grashof = G * beta * dT * height**3 / (nu * nu)
    prandtl = cp * mu / k
    nusselt = float(Nu_vertical_plate_Churchill(prandtl, grashof))
    h = nusselt * k / height
    return GasFilm(
        hA=h * area,
        h=h,
        area=area,
        grashof=grashof,
        prandtl=prandtl,
        nusselt=nusselt,
        delta_T=dT,
    )
