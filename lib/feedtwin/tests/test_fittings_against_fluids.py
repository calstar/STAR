"""Fitting adapters against the ``fluids`` functions they adapt.

The module docstring of :mod:`feedtwin.comps.correlations` says every fitting is
an adapter onto ``fluids`` and computes nothing of its own. These hold it to
that: the K a fitting component prices must be the K ``fluids`` gives for the
same geometry, in the units ``fluids`` documents.
"""

from __future__ import annotations

import math

import fluids.fittings as ft
import pytest

from feedtwin.comps import build_component, conditions_from_fluid
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.props import Fluid

M = Provenance.MANUFACTURER
BORE = 0.0095


def _ethanol() -> object:
    return conditions_from_fluid(Fluid("ethanol"), 4.0e6, 293.0)


def _K(component: object, mdot: float, flow: object) -> float:
    rho = flow.rho  # type: ignore[attr-defined]
    v = mdot / (rho * math.pi * BORE**2 / 4.0)
    return component.pressure_drop(mdot, flow) / (0.5 * rho * v * v)  # type: ignore[attr-defined]


def _fitting(kind: str, **extra: Param) -> object:
    params = {"bore": Param(BORE * 1e3, "mm", M, "test")}
    params.update(extra)
    return build_component(
        ComponentInstance.build("F", "fitting", params, options={"kind": kind})
    )


@pytest.mark.parametrize("degrees", [45.0, 90.0, 180.0])
def test_a_bend_fitting_reads_its_angle_in_degrees(degrees: float) -> None:
    """``fluids.bend_rounded`` takes its angle in degrees.

    The fitting's ``angle`` parameter is an *angle* dimension, so the model
    layer hands it over in radians; passed straight through, a 90-degree bend
    priced as a 1.57-degree one (K 0.018 against 0.229).
    """
    flow = _ethanol()
    mdot = 1.0
    bend = _fitting(
        "bend",
        angle=Param(degrees, "deg", M, "test"),
        bend_diameters=Param(1.5, "-", M, "test"),
    )
    Re = 4.0 * mdot / (math.pi * BORE * flow.mu)  # type: ignore[attr-defined]
    expected = ft.bend_rounded(
        Di=BORE, angle=degrees, bend_diameters=1.5, Re=Re, roughness=1.5e-6
    )
    assert _K(bend, mdot, flow) == pytest.approx(expected, rel=1e-9)


def test_a_bend_fitting_equals_the_bend_component() -> None:
    """Same geometry, two components, one correlation: one K."""
    flow = _ethanol()
    fitting = _fitting(
        "bend",
        angle=Param(90.0, "deg", M, "test"),
        bend_diameters=Param(1.5, "-", M, "test"),
    )
    bend = build_component(
        ComponentInstance.build(
            "B",
            "bend",
            {
                "bore": Param(BORE * 1e3, "mm", M, "test"),
                "bend_radius": Param(1.5 * BORE * 1e3, "mm", M, "test"),
                "angle": Param(90.0, "deg", M, "test"),
                "roughness": Param(1.5e-6, "m", M, "test"),
            },
            model="rounded",
        )
    )
    assert _K(fitting, 1.0, flow) == pytest.approx(_K(bend, 1.0, flow), rel=1e-9)
