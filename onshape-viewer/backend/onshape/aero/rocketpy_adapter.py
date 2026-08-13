"""Feed our CAD-derived, Mach-dependent CP/CNa into RocketPy's flight integration.

RocketPy owns the 6-DOF *trajectory* (validated against real flight data), but its
stock fin model pins the fin CP at a fixed geometric value -- it never migrates with
Mach. This adapter replaces that with **our** ``AeroCore`` (OpenRocket-faithful CP(M)
+ CNa(M) straight off the CAD), so RocketPy integrates the trajectory -- and the
stability margin throughout flight -- against our centre of pressure.

## How the CP gets in

RocketPy's ``GenericSurface`` / ``LinearGenericSurface`` accept coefficient callables
of ``(alpha, beta, mach, reynolds, pitch_rate, yaw_rate, roll_rate)``. Its
``center_of_pressure`` application point is a fixed tuple -- *not* Mach-variable -- so
we encode a Mach-dependent CP through the **pitch-moment coefficient** about a fixed
reference point ``x_ref``:

    cL_alpha(mach) = CNa(M)                                  # our merged normal-force slope
    cm_alpha(mach) = -CNa(M) * (x_cp(M) - x_ref) / L_ref     # moment that places it at x_cp

so RocketPy's effective CP each step is ``x_ref - (cm/cN)*L_ref = x_cp(M)``. The
identity holds for *any* ``x_ref`` (it cancels), which ``effective_cp`` checks. No
fork of RocketPy is required for this route.

Positions here are axial coordinates in the same nose->tail frame the aero core uses
(``profile.x_fore`` is the nose tip). Mapping that onto RocketPy's own coordinate
convention when the ``Rocket`` is assembled is the one piece that needs a live-run
validation pass -- see ``build_linear_generic_surface``.
"""

from __future__ import annotations

from collections.abc import Callable

from .stability import AeroCore, aero_at_mach


def cl_alpha_of_mach(core: AeroCore) -> Callable[[float], float]:
    """Return M -> CNa(M), the merged (body+fins) normal-force slope per radian."""

    def cl_alpha(mach: float) -> float:
        return aero_at_mach(core, mach)[1]

    return cl_alpha


def cm_alpha_of_mach(core: AeroCore, x_ref: float, ref_length: float) -> Callable[[float], float]:
    """Return M -> cm_alpha(M), the pitch-moment slope about ``x_ref`` (per radian).

    ``cm_alpha = -CNa(M)*(x_cp(M) - x_ref)/ref_length``. Nose-forward axial frame:
    a CP aft of ``x_ref`` (x_cp > x_ref) gives a negative (restoring) pitch moment.
    """

    def cm_alpha(mach: float) -> float:
        cp_axial, cna = aero_at_mach(core, mach)
        return -cna * (cp_axial - x_ref) / ref_length

    return cm_alpha


def effective_cp(cl_alpha: float, cm_alpha: float, x_ref: float, ref_length: float) -> float:
    """Invert the encoding: the CP that ``(cl_alpha, cm_alpha)`` about ``x_ref`` imply.

    ``x_cp = x_ref - (cm_alpha/cl_alpha)*ref_length``. Used to prove the round-trip:
    feeding our coefficients back out must reproduce ``x_cp(M)``.
    """
    if cl_alpha == 0:
        return x_ref
    return x_ref - (cm_alpha / cl_alpha) * ref_length


def build_linear_generic_surface(
    core: AeroCore,
    x_ref: float | None = None,
):
    """Build a RocketPy ``LinearGenericSurface`` carrying our CP(M)/CNa(M).

    Lazy-imports ``rocketpy`` so this module stays importable without the (heavy)
    dependency; raises a clear error if it is missing. ``reference_area`` /
    ``reference_length`` come from the airframe max radius; ``x_ref`` defaults to the
    nose tip (``profile.x_fore``).

    NB: the mapping of our nose->tail axial frame onto RocketPy's ``Rocket`` coordinate
    system (origin, sign) must be validated against a live RocketPy ``Flight`` run --
    the coefficient math (``effective_cp`` round-trip) is convention-independent, but
    where RocketPy *places* the surface is not. Treat this constructor as scaffolding
    until that pass is done.
    """
    try:
        from rocketpy import LinearGenericSurface  # type: ignore
    except ModuleNotFoundError as exc:  # pragma: no cover - exercised only without rocketpy
        raise ModuleNotFoundError(
            "rocketpy is required to build a flight surface; install it to run the "
            "6-DOF trajectory (the CP/CNa coefficient math needs no rocketpy)."
        ) from exc

    import math

    r_max = core.profile.r_max
    ref_length = 2.0 * r_max
    ref_area = math.pi * r_max * r_max
    if x_ref is None:
        x_ref = core.profile.x_fore

    cl_alpha = cl_alpha_of_mach(core)
    cm_alpha = cm_alpha_of_mach(core, x_ref, ref_length)

    # LinearGenericSurface coefficient callables take (alpha, beta, mach, reynolds,
    # pitch_rate, yaw_rate, roll_rate); we depend on mach only. cL/cm are linear in
    # alpha via their _alpha derivatives, which is the AoA-0 Barrowman regime we ported.
    return LinearGenericSurface(
        reference_area=ref_area,
        reference_length=ref_length,
        coefficients={
            "cL_alpha": lambda a, b, mach, re, p, q, r: cl_alpha(mach),
            "cm_alpha": lambda a, b, mach, re, p, q, r: cm_alpha(mach),
        },
    )
