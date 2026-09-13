"""Friction factors and fitting losses, as registries rather than choices.

Two registries, both extensible from outside this package, both wrapping
``fluids`` rather than reimplementing it.

**Friction factors.** Colebrook is implicit and has to be iterated; a dozen
explicit approximations to it exist, and they disagree in the third significant
figure. Which one a project uses is a modelling decision, not a fact, so it is
an *option* on the component -- ``pipe.options.friction`` -- and changing it is
a config edit.

**Fitting losses.** Crane TP-410's resistance coefficients, plus the Hooper 2K
and Darby 3K methods, all of which ``fluids`` implements and validates against
the source books. Every fitting here is a thin adapter that unpacks a uniform
context into the arguments one of those functions wants -- deliberately thin, so
that what this package contributes is the plumbing and never the physics.

Nothing in this module computes a loss coefficient from first principles. If a
number here disagrees with Crane, it is this module's adapter that is wrong.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Mapping

import fluids.fittings as ft
from fluids.friction import friction_factor, friction_factor_methods

#: Explicit friction-factor correlations, by the name used in a config.
#:
#: Asked of ``fluids`` rather than listed here, so the two cannot disagree. A
#: hand-maintained list is how ``"Blasius"`` ended up in an early draft of this
#: file: a real correlation, a real function in ``fluids``, and not a name
#: ``friction_factor`` accepts -- which failed only when something selected it.
#:
#: All are Darcy friction factors. Clamond is the default: it solves the
#: Colebrook equation essentially exactly rather than approximating it, and is
#: fast enough that there is no reason to approximate.
FRICTION_METHODS: tuple[str, ...] = tuple(
    sorted(friction_factor_methods(Re=1.0e5, eD=1.0e-4))
)

DEFAULT_FRICTION_METHOD = "Clamond"

#: Below this Reynolds number the flow is laminar and f = 64/Re exactly.
#: ``fluids`` applies the same transition internally; it is named here because
#: components report which regime they were in, and a silent regime switch is
#: worth being able to see.
LAMINAR_LIMIT = 2040.0
"""Laminar-turbulent transition, from fluids.friction.LAMINAR_TRANSITION_PIPE."""


def darcy_friction_factor(Re: float, roughness_ratio: float, method: str) -> float:
    """Darcy friction factor from a named correlation.

    Args:
        Re: Reynolds number.
        roughness_ratio: Absolute roughness over bore, e/D.
        method: One of :data:`FRICTION_METHODS`.

    Zero and negative Reynolds numbers return zero rather than raising: a
    solver's first iterate legitimately passes through zero flow, and a
    component with no flow through it has no frictional loss.

    Below the transition the answer is 64/Re regardless of which turbulent
    correlation was named -- ``fluids`` applies that itself, and it matters
    because a solve sweeping down toward zero flow passes through the laminar
    regime whether or not the design point is anywhere near it.
    """
    if Re <= 0.0:
        return 0.0
    if method not in FRICTION_METHODS:
        raise ValueError(
            f"unknown friction method {method!r}; available: "
            f"{', '.join(FRICTION_METHODS)}"
        )
    return float(friction_factor(Re=Re, eD=roughness_ratio, Method=method))


def reynolds(mdot: float, bore: float, rho: float, mu: float) -> float:
    """Reynolds number from mass flow. ``Re = 4 m / (pi D mu)``.

    Written in terms of mass flow rather than velocity because that is what a
    network solver carries, and going via velocity would divide by density and
    then multiply by it again.
    """
    if bore <= 0.0 or mu <= 0.0:
        return 0.0
    return abs(4.0 * mdot / (math.pi * bore * mu))


def velocity(mdot: float, bore: float, rho: float) -> float:
    """Bulk velocity [m/s] through a circular bore."""
    if bore <= 0.0 or rho <= 0.0:
        return 0.0
    return mdot / (rho * math.pi * bore * bore / 4.0)


@dataclass(frozen=True, slots=True)
class FittingContext:
    """What every fitting correlation is given.

    A uniform shape, so the registry can hold functions whose underlying
    ``fluids`` signatures differ wildly -- a rounded bend wants an angle and a
    bend radius, a contraction wants two diameters, an exit wants nothing.
    """

    bore: float
    """Bore of the run the fitting sits in [m]."""

    Re: float
    roughness: float
    fd: float
    """Friction factor of the attached pipe, which several Crane correlations
    scale with."""

    params: Mapping[str, float] = field(default_factory=dict)
    """Fitting-specific geometry: ``angle``, ``bore2``, ``bend_diameters``."""

    def get(self, name: str, default: float) -> float:
        return float(self.params.get(name, default))


#: A fitting correlation: context in, resistance coefficient out.
FittingK = Callable[[FittingContext], float]

_FITTINGS: dict[str, FittingK] = {}


def register_fitting(name: str, fn: FittingK) -> None:
    """Register a fitting correlation. Replacing a name is allowed."""
    _FITTINGS[name] = fn


def get_fitting(name: str) -> FittingK:
    if name not in _FITTINGS:
        raise ValueError(
            f"unknown fitting {name!r}; registered: {', '.join(registered_fittings())}"
        )
    return _FITTINGS[name]


def registered_fittings() -> list[str]:
    return sorted(_FITTINGS)


def fitting_K(name: str, ctx: FittingContext) -> float:
    """Resistance coefficient of one fitting, referred to ``ctx.bore``."""
    return float(get_fitting(name)(ctx))


# --------------------------------------------------------------------------
# The shipped set. Each is an adapter onto fluids; none computes anything.
# --------------------------------------------------------------------------


def _bend(ctx: FittingContext, angle: float) -> float:
    return float(
        ft.bend_rounded(
            Di=ctx.bore,
            angle=ctx.get("angle", angle),
            Re=ctx.Re or None,
            roughness=ctx.roughness,
            bend_diameters=ctx.get("bend_diameters", 5.0),
        )
    )


def _contraction(ctx: FittingContext) -> float:
    return float(
        ft.contraction_sharp(
            Di1=ctx.bore, Di2=ctx.get("bore2", ctx.bore * 0.5), Re=ctx.Re or None
        )
    )


def _expansion(ctx: FittingContext) -> float:
    return float(
        ft.diffuser_sharp(
            Di1=ctx.bore, Di2=ctx.get("bore2", ctx.bore * 2.0), Re=ctx.Re or None
        )
    )


def _crane(constant: float) -> FittingK:
    """A Crane coefficient expressed as a multiple of the pipe friction factor.

    Crane TP-410 gives many fittings as ``K = n . f_T``, where f_T is the
    fully-turbulent friction factor of the attached pipe -- which is why
    :class:`FittingContext` carries one.
    """

    def K(ctx: FittingContext) -> float:
        return constant * ctx.fd

    return K


register_fitting("elbow_90", lambda ctx: _bend(ctx, 90.0))
register_fitting("elbow_45", lambda ctx: _bend(ctx, 45.0))
register_fitting("bend", lambda ctx: _bend(ctx, ctx.get("angle", 90.0)))
register_fitting("contraction", _contraction)
register_fitting("expansion", _expansion)
register_fitting("entrance_sharp", lambda ctx: float(ft.entrance_sharp()))
register_fitting("exit", lambda ctx: float(ft.exit_normal()))
register_fitting(
    "tee_run",
    lambda ctx: float(ft.K_run_converging_Crane(ctx.bore, ctx.bore, 0.5, 0.5)),
)
register_fitting(
    "tee_branch",
    lambda ctx: float(ft.K_branch_converging_Crane(ctx.bore, ctx.bore, 0.5, 0.5)),
)
register_fitting(
    "ball_valve_full",
    lambda ctx: float(ft.K_ball_valve_Crane(ctx.bore, ctx.bore, 0.0)),
)
register_fitting(
    "gate_valve_full",
    lambda ctx: float(ft.K_gate_valve_Crane(ctx.bore, ctx.bore, 0.0)),
)
register_fitting(
    "globe_valve", lambda ctx: float(ft.K_globe_valve_Crane(ctx.bore, ctx.bore))
)
register_fitting(
    "swing_check", lambda ctx: float(ft.K_swing_check_valve_Crane(ctx.bore))
)
# Crane's f_T multiples, for fittings given that way in the book.
register_fitting("elbow_90_crane", _crane(30.0))
register_fitting("elbow_45_crane", _crane(16.0))
