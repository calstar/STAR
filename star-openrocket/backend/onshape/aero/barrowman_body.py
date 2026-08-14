"""Barrowman normal-force and centre-of-pressure for an axisymmetric body.

This is a faithful port of OpenRocket's ``SymmetricComponentCalc`` (release-24.12,
``info.openrocket.core.aerodynamics.barrowman``), reduced to the static case
OpenRocket's design view shows: **Mach 0.3, AoA 0**. At AoA 0 the Galejs body-lift
term (``getLiftCP``, weight ``∝ sin(aoa)·sinc(aoa)``) contributes zero weight and
drops out, so the static number is pure slender-body pressure theory.

OpenRocket applies these per component (nose, transition, tube, boattail) and then
CNa-weights each component's cp into the total (``AerodynamicForces.merge``). For a
body reconstructed from a CAD outer surface we do not have a component tree, but the
per-component sum **telescopes exactly** into a single integral over the outer
radius profile ``r(x)``:

    Σ CNa_i           = (2 / A_ref) · (A_aft − A_fore)
    Σ (CNa_i · x_i)    = (2 / A_ref) · (x_aft·A_aft − x_fore·A_fore − V)

with ``V = ∫π r(x)² dx`` the solid volume of revolution. Dividing gives the same
cp OpenRocket would report:

    x_cp = (x_aft·A_aft − x_fore·A_fore − V) / (A_aft − A_fore)

A straight tube has ``A_aft == A_fore`` so contributes zero CNa and no cp weight,
exactly as OpenRocket's ``isTube`` branch does. Checks: a cone (A_fore=0) gives
x_cp = 2L/3 and CNa = 2 (referenced to its base); adding a tube leaves both
unchanged.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class BodyAero:
    """Barrowman result for a body of revolution, at AoA 0."""

    cna: float  # normal-force coefficient derivative, referenced to a_ref
    cp: float  # centre-of-pressure axial position, in the profile's x units
    a_ref: float  # reference area used (π r_max²)

    @property
    def weight(self) -> float:
        """CNa is the weight used when merging cps (matches OpenRocket)."""
        return self.cna


def reference_area(r_max: float) -> float:
    """OpenRocket default ``ReferenceType.MAXIMUM``: A_ref = π·r_max²."""
    return math.pi * r_max * r_max


def body_cna(a_fore: float, a_aft: float, a_ref: float) -> float:
    """Slender-body CNa = 2·(A_aft − A_fore) / A_ref."""
    if a_ref <= 0:
        return 0.0
    return 2.0 * (a_aft - a_fore) / a_ref


def body_cp(
    x_fore: float, x_aft: float, a_fore: float, a_aft: float, volume: float
) -> float:
    """Axial cp of a body of revolution (telescoped Barrowman integral).

    ``volume`` is the enclosed solid volume of revolution between ``x_fore`` and
    ``x_aft`` (∫π r² dx), NOT the mesh's material volume. When A_aft == A_fore
    (a pure tube) the cp is undefined but its weight is zero, so any finite value
    is harmless; we return the midpoint to avoid a divide-by-zero.
    """
    denom = a_aft - a_fore
    if abs(denom) < 1e-18:
        return 0.5 * (x_fore + x_aft)
    return (x_aft * a_aft - x_fore * a_fore - volume) / denom


def body_aero(
    *,
    x_fore: float,
    x_aft: float,
    r_fore: float,
    r_aft: float,
    volume: float,
    r_max: float,
) -> BodyAero:
    """Assemble the full body Barrowman result from profile scalars."""
    a_ref = reference_area(r_max)
    a_fore = math.pi * r_fore * r_fore
    a_aft = math.pi * r_aft * r_aft
    return BodyAero(
        cna=body_cna(a_fore, a_aft, a_ref),
        cp=body_cp(x_fore, x_aft, a_fore, a_aft, volume),
        a_ref=a_ref,
    )
