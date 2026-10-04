"""Gas through a flow coefficient, with expansion and choking, per IEC 60534-2-1.

For the components that opt in: the relief valve (:mod:`feedtwin.comps.relief`)
always, and the regulator seat when ``Setup.regulator_compressible_seat`` is on
(:mod:`feedtwin.comps.regulator`). The plain :class:`~feedtwin.comps.elements.Valve`
is untouched.

The standard
------------
IEC 60534-2-1:2011, *Industrial-process control valves -- Part 2-1: Flow
capacity -- Sizing equations for fluid flow under installed conditions*,
compressible fluids, turbulent flow, no fittings (F_P = 1):

.. code-block:: text

    W = N6 . C . Y . sqrt(x . p1 . rho1)               non-choked
    Y = 1 - x / (3 . F_gamma . xT)                     expansion factor
    F_gamma = gamma / 1.40                             specific heat ratio factor
    choked once x >= F_gamma . xT, where Y = 2/3 and W stops depending on p2

with ``x = (p1 - p2) / p1``. Inverting it for the drop at a given flow is a cubic
in ``x`` (:func:`expansion_drop`); past the choke there is no drop that passes
the flow, and the caller pins the flow at :meth:`GasCv.capacity` instead.

The scale, ``N6 . C``
---------------------
Not the tabulated N6. The coefficient is the library's own Cv-to-K conversion,
``fluids.fittings.Cv_to_K`` -- the Cv definition, one US gallon per minute of
water at one psi -- so that ``Y -> 1`` reproduces exactly the incompressible law
the rest of the library already uses for the same Cv. It agrees with IEC's
N6 = 2.73 (Cv, kg/h, kPa) to 0.15 %. (The library's
:func:`~feedtwin.comps.elements._calibrate_choke`, used by the plain valve's
choked ceiling, is 5.4 % lower: it calibrates against ``fluids``'s N9, which is
referenced to 0 degC, with a standard density taken at 15 degC. Reported, not
changed here.)

gamma
-----
The standard's ``gamma`` is the gas's ratio of specific heats as an ideal-gas
property (air and nitrogen 1.40, helium 1.66), not the real-gas cp/cv at the
inlet: for nitrogen at 1055 psia and 200 K, near a GN2 burnout, cp/cv is 1.84
(CoolProp), and using it would raise the flow at the drop seen there by 6 %.
:func:`iec_gamma` takes ``FlowConditions.gamma_ideal`` -- cp/cv at 1 kPa and the
node temperature, which :func:`~feedtwin.comps.elements.conditions_from_fluid`
fills for every gas-priced node -- and falls back to the real-gas value only when
the caller built conditions by hand without it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from fluids.fittings import Cv_to_K

from feedtwin.comps.base import FlowConditions

#: IEC 60534-2-1's typical pressure-differential ratio factor at choked flow,
#: for a valve that does not state its own. **Assumed**: it is the single
#: largest uncertainty in a choked-gas prediction (about 0.3 for a butterfly to
#: 0.8 for some globe trims).
XT_TYPICAL = 0.70

#: Reference pressure the ideal-gas ratio of specific heats is taken at [Pa].
GAMMA_IDEAL_PRESSURE = 1.0e3


def iec_gamma(flow: FlowConditions) -> float:
    """The ratio of specific heats IEC 60534's F_gamma is built from: the
    ideal-gas value when the conditions carry it, else the real-gas cp/cv."""
    return flow.gamma_ideal if flow.gamma_ideal > 0.0 else flow.gamma


def is_gas(flow: FlowConditions) -> bool:
    """Whether these conditions were priced as a gas.

    :func:`~feedtwin.comps.elements.conditions_from_fluid` fills
    ``gamma_ideal`` only for a gas-priced node; a liquid leaves it zero and
    keeps the incompressible law.
    """
    return flow.gamma_ideal > 0.0 and flow.rho > 0.0 and flow.p_upstream > 0.0


def expansion_drop(a: float, x_critical: float) -> float:
    """``x`` in ``[0, x_critical]`` solving ``x . Y(x)^2 = a``.

    ``Y = 1 - x / (3 x_critical)``. The left side rises monotonically from 0 to
    ``4 x_critical / 9`` at the choke; ``a`` at or past that returns the choke.
    Newton on a bracket, bisecting whenever a step leaves it.
    """
    if a <= 0.0:
        return 0.0
    c = x_critical
    if a >= 4.0 * c / 9.0:
        return c
    lo, hi = 0.0, c
    x = min(a, c)
    for _ in range(100):
        y = 1.0 - x / (3.0 * c)
        residual = x * y * y - a
        if residual > 0.0:
            hi = x
        else:
            lo = x
        slope = y * (1.0 - x / c)
        candidate = x - residual / slope if slope > 0.0 else 0.5 * (lo + hi)
        if not lo < candidate < hi:
            candidate = 0.5 * (lo + hi)
        if abs(candidate - x) <= 1e-15 * c + 1e-300:
            return candidate
        x = candidate
    return x


@dataclass(frozen=True, slots=True)
class GasCv:
    """A flow coefficient seen by a gas: IEC 60534-2-1 with the library's scale."""

    cv: float
    """Flow coefficient, US gpm of water at 1 psi."""
    bore: float
    """The bore the Cv's K is referenced to [m] (cancels out of the flow)."""
    xT: float
    """Pressure-differential ratio factor at choked flow."""

    def _scale(self, rho1: float) -> float:
        """``N6 . C . sqrt(rho1)`` in SI: kg/s per sqrt(Pa) at Y = 1."""
        if self.cv <= 0.0 or self.bore <= 0.0 or rho1 <= 0.0:
            return 0.0
        area = math.pi * self.bore * self.bore / 4.0
        return area * math.sqrt(2.0 * rho1 / Cv_to_K(self.cv, self.bore))

    def x_critical(self, gamma: float) -> float:
        """``F_gamma . xT``: the drop ratio at which the flow chokes, never past
        1 (a downstream pressure below zero)."""
        return min((gamma / 1.40) * self.xT, 1.0)

    def flow(self, p1: float, rho1: float, gamma: float, dp: float) -> float:
        """Mass flow at a drop ``dp`` [kg/s]; the choked value past the choke."""
        if dp <= 0.0 or p1 <= 0.0:
            return 0.0
        c = self.x_critical(gamma)
        x = min(dp / p1, c)
        y = 1.0 - x / (3.0 * c)
        return self._scale(rho1) * y * math.sqrt(x * p1)

    def capacity(self, p1: float, rho1: float, gamma: float) -> float:
        """Choked mass flow [kg/s]: ``Y = 2/3`` at ``x = F_gamma . xT``."""
        c = self.x_critical(gamma)
        return self._scale(rho1) * (2.0 / 3.0) * math.sqrt(c * max(p1, 0.0))

    def drop(self, mdot: float, p1: float, rho1: float, gamma: float) -> float:
        """Pressure drop that passes ``|mdot|`` [Pa].

        Up to the choked capacity this is the inverse of :meth:`flow`. Past it no
        drop passes the flow -- the caller should pin it at :meth:`capacity` --
        and the value returned there is ``x_crit p1 (mdot / capacity)^2``:
        continuous at the choke and rising, so a solver iterate that strays past
        it is pushed back rather than handed a cliff.
        """
        magnitude = abs(mdot)
        scale = self._scale(rho1)
        if magnitude == 0.0 or scale <= 0.0 or p1 <= 0.0:
            return 0.0
        c = self.x_critical(gamma)
        choked = scale * (2.0 / 3.0) * math.sqrt(c * p1)
        if magnitude >= choked:
            return c * p1 * (magnitude / choked) ** 2
        a = (magnitude / scale) ** 2 / p1
        return expansion_drop(a, c) * p1
