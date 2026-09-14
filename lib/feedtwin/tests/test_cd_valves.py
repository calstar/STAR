"""A valve given as Cd is the Cv valve with the number converted once."""

from __future__ import annotations

import math

import pytest

from feedtwin.comps.elements import cv_from_cd
from feedtwin.model.spec import get_component_spec
from feedtwin.model.component import ComponentInstance
from feedtwin.model.param import Param, Provenance
from feedtwin.comps import build_component


def _p(value: float, unit: str) -> Param:
    return Param(value, unit, Provenance.MANUFACTURER, "test")


def test_cv_from_cd_is_38_per_square_inch() -> None:
    # A bore of 1.1284 in is one square inch.
    assert cv_from_cd(1.0, 1.1284 * 0.0254) == pytest.approx(38.0, rel=1e-3)
    assert cv_from_cd(0.6, 1.1284 * 0.0254) == pytest.approx(22.8, rel=1e-3)


def test_a_cd_valve_drops_the_same_pressure_as_its_cv_twin() -> None:
    bore = 12.7e-3
    cd = 0.6
    cv_twin = build_component(
        ComponentInstance.build(
            "MV-CV",
            "valve",
            {"Cv": _p(cv_from_cd(cd, bore), "Cv"), "bore": _p(bore, "m")},
            model="cv",
        )
    )
    cd_valve = build_component(
        ComponentInstance.build(
            "MV-CD", "valve", {"Cd": _p(cd, "-"), "bore": _p(bore, "m")}, model="cd"
        )
    )
    from feedtwin.comps.base import FlowConditions

    flow = FlowConditions(rho=998.0, mu=1e-3, p_upstream=50e5)
    for mdot in (0.05, 0.2, 0.5):
        assert cd_valve.pressure_drop(mdot, flow) == pytest.approx(
            cv_twin.pressure_drop(mdot, flow), rel=1e-9
        )


def test_the_catalogue_offers_cd_for_valves_and_check_valves() -> None:
    for kind in ("valve", "check_valve"):
        spec = get_component_spec(kind)
        assert "cd" in spec.models
        assert "Cd" in {ps.name for ps in spec.params}


def test_a_cd_check_valve_builds_and_flows_forward() -> None:
    from feedtwin.comps.base import FlowConditions

    cv = build_component(
        ComponentInstance.build(
            "CV-1",
            "check_valve",
            {"Cd": _p(0.7, "-"), "bore": _p(9.5e-3, "m")},
            model="cd",
        )
    )
    flow = FlowConditions(rho=998.0, mu=1e-3, p_upstream=50e5)
    assert math.isfinite(cv.pressure_drop(0.1, flow))
    assert cv.pressure_drop(0.1, flow) > 0.0
