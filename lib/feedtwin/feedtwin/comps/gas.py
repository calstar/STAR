"""Compressible flow: the pressurant path.

The liquid side is nearly incompressible, so a loss coefficient and a dynamic
head describe it. Gas is not, and two things change:

**Density falls as pressure does.** A long gas line is not one density; the
velocity climbs along it as the gas expands. Below roughly 10% pressure drop the
error in ignoring that is small, and above it the line has to be integrated.

**Flow chokes.** Below a critical pressure ratio the throat goes sonic and mass
flow stops depending on downstream pressure entirely. That is not a numerical
inconvenience -- it is how a regulator seat and a relief orifice actually behave,
and it puts a hard ceiling on what a restriction can pass. Asked for more than
that ceiling, this raises :class:`~feedtwin.comps.base.InfeasibleOperatingPoint`
rather than returning a pressure that cannot exist.

Everything here is expressed in the same direction as the liquid components --
pressure drop as a function of mass flow -- so the network solver needs to know
nothing about which side of the system it is assembling.
"""

from __future__ import annotations

import math

from scipy.optimize import brentq

from feedtwin.comps.base import (
    R_UNIVERSAL,
    FlowConditions,
    HydraulicComponent,
    InfeasibleOperatingPoint,
    register_builder,
)
from feedtwin.comps.correlations import velocity

#: Re-exported. It is defined in :mod:`feedtwin.comps.base` so that
#: :mod:`feedtwin.comps.elements` can reach it without a per-call import --
#: this module imports ``elements``, so ``elements`` cannot import this one.
__all__ = ["R_UNIVERSAL"]


def critical_pressure_ratio(gamma: float) -> float:
    """``p_throat / p_upstream`` at which the throat goes sonic.

    About 0.528 for a diatomic gas, 0.487 for helium. Below this the throat is
    choked and downstream pressure stops mattering.
    """
    return float((2.0 / (gamma + 1.0)) ** (gamma / (gamma - 1.0)))


def choked_mass_flow(
    area: float,
    cd: float,
    p_upstream: float,
    temperature: float,
    gamma: float,
    r_specific: float,
) -> float:
    """The most a restriction can pass at this upstream state [kg/s].

    ``mdot = Cd A p1 sqrt(gamma / (R T)) . (2/(gamma+1))^((gamma+1)/(2(gamma-1)))``

    A hard ceiling, not an asymptote. Opening the downstream side further buys
    nothing once this is reached, which is why a relief orifice is sized on it
    and why a regulator seat behaves the way it does.
    """
    if area <= 0.0 or temperature <= 0.0 or r_specific <= 0.0:
        return 0.0
    factor = (2.0 / (gamma + 1.0)) ** ((gamma + 1.0) / (2.0 * (gamma - 1.0)))
    return float(
        cd * area * p_upstream * math.sqrt(gamma / (r_specific * temperature)) * factor
    )


def subsonic_mass_flow(
    area: float,
    cd: float,
    p_upstream: float,
    pressure_ratio: float,
    temperature: float,
    gamma: float,
    r_specific: float,
) -> float:
    """Mass flow through an unchoked restriction [kg/s]."""
    if pressure_ratio >= 1.0 or area <= 0.0:
        return 0.0
    term = pressure_ratio ** (2.0 / gamma) - pressure_ratio ** ((gamma + 1.0) / gamma)
    if term <= 0.0:
        return 0.0
    coefficient = (2.0 * gamma) / ((gamma - 1.0) * r_specific * temperature)
    return cd * area * p_upstream * math.sqrt(coefficient * term)


class GasOrifice(HydraulicComponent):
    """A restriction in compressible flow: choked above a pressure ratio.

    Inverted from the usual direction. The textbook relation gives mass flow
    from a pressure ratio; a network solve carries flows and wants pressures, so
    this brackets the pressure ratio between choking and unity and solves for
    the one that passes the requested flow.

    The bracket is what makes it robust: the relation is monotonic over that
    interval, so a root always exists unless the flow exceeds the choked
    ceiling -- and that case is reported as infeasible rather than iterated on.
    """

    def _geometry(self) -> tuple[float, float]:
        d = self.p["bore"]
        return math.pi * d * d / 4.0, self.p["Cd"]

    def _gas(self, flow: FlowConditions) -> tuple[float, float, float]:
        """gamma, specific gas constant, temperature -- from the conditions.

        ``FlowConditions`` carries what a liquid needs; a gas also needs the
        heat capacity ratio and a gas constant. Both are derived from what is
        already there rather than added to the struct, so the liquid components
        are untouched.
        """
        gamma = flow.gamma if flow.gamma > 1.0 else 1.4
        r_specific = flow.r_specific if flow.r_specific > 0.0 else 296.8
        temperature = (
            flow.temperature
            if flow.temperature > 0.0
            else flow.p_upstream / (flow.rho * r_specific)
        )
        return gamma, r_specific, temperature

    def choked_flow(self, flow: FlowConditions) -> float:
        area, cd = self._geometry()
        gamma, r_specific, temperature = self._gas(flow)
        return choked_mass_flow(
            area, cd, flow.p_upstream, temperature, gamma, r_specific
        )

    def flow_ceiling(self, flow: FlowConditions) -> float | None:
        return self.choked_flow(flow)

    def is_choked(self, dp_available: float, flow: FlowConditions) -> bool:
        gamma, _r, _t = self._gas(flow)
        critical = flow.p_upstream * (1.0 - critical_pressure_ratio(gamma))
        return dp_available >= critical

    def choking_pressure_drop(self, flow: FlowConditions) -> float:
        """The drop at which the throat goes sonic [Pa]. About 47% of p_up."""
        gamma, _r, _t = self._gas(flow)
        return flow.p_upstream * (1.0 - critical_pressure_ratio(gamma))

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        magnitude = abs(mdot)
        if magnitude == 0.0:
            return 0.0

        area, cd = self._geometry()
        gamma, r_specific, temperature = self._gas(flow)
        ceiling = choked_mass_flow(
            area, cd, flow.p_upstream, temperature, gamma, r_specific
        )
        if magnitude >= ceiling:
            raise InfeasibleOperatingPoint(self.id, mdot, flow.p_upstream)

        pr_crit = critical_pressure_ratio(gamma)

        def residual(pr: float) -> float:
            return (
                subsonic_mass_flow(
                    area, cd, flow.p_upstream, pr, temperature, gamma, r_specific
                )
                - magnitude
            )

        # Monotonic between choking and no-flow, so a bracket is guaranteed.
        ratio = brentq(residual, pr_crit, 1.0 - 1e-12, xtol=1e-12)
        return flow.p_upstream * (1.0 - float(ratio))

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        gamma, _r, temperature = self._gas(flow)
        ceiling = self.choked_flow(flow)
        out = {
            "mdot_choked": ceiling,
            "choked_fraction": abs(mdot) / ceiling if ceiling > 0.0 else 0.0,
            "pressure_ratio_critical": critical_pressure_ratio(gamma),
            "gamma": gamma,
            "temperature": temperature,
            "velocity_throat": velocity(mdot, self.p["bore"], flow.rho),
        }
        try:
            out["dp"] = self.pressure_drop(mdot, flow)
        except InfeasibleOperatingPoint:
            out["dp"] = float("nan")
            out["choked"] = 1.0
        else:
            out["choked"] = 0.0
        return out


def _measured_gas(instance: object) -> HydraulicComponent:
    from feedtwin.comps.elements import MeasuredElement

    return MeasuredElement(instance)  # type: ignore[arg-type]


register_builder("gas_orifice", "isentropic", GasOrifice)
register_builder("gas_orifice", "measured", _measured_gas)
