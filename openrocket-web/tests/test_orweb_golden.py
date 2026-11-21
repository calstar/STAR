"""orweb's component model and mass calculation against OpenRocket 24.12 itself.

For every golden rocket (OpenRocket's examples in tests/rockets, and the orweb-written
variants in tests/variants), load the .ork through the document and the component model
and compare with the oracle's dump of the same file: every component's instance
locations, mass, CG, unit inertias and geometry; the launch / structure / burnout /
motor rigid bodies; the CM analysis; the motors and every flight configuration.
See tests/_orweb_check.py for the fields and tolerance.
"""

from __future__ import annotations

import json

import pytest

from _orweb_check import (case_id, cases, cm_mismatches, component_mismatches, load, motor_mismatches,
                          rocket_mismatches)

CASES = cases()


@pytest.fixture(scope="module", params=CASES, ids=[case_id(c) for c in CASES])
def built(request):
    ork, gpath = request.param
    g = json.loads(gpath.read_text())
    return load(ork, g), g


def _report(m) -> str:
    return f"{len(m)} mismatches:\n  " + "\n  ".join(m[:25])


def test_there_are_golden_rockets():
    assert len(CASES) >= 30


def test_components(built):
    rocket, g = built
    m = component_mismatches(rocket, g)
    assert not m, _report(m)


def test_rocket_mass_cg_inertia(built):
    rocket, g = built
    m = rocket_mismatches(rocket, g)
    assert not m, _report(m)


def test_cm_analysis(built):
    rocket, g = built
    m = cm_mismatches(rocket, g)
    assert not m, _report(m)


def test_motors_and_configurations(built):
    rocket, g = built
    m = motor_mismatches(rocket, g)
    assert not m, _report(m)


def test_build_warns_about_nothing(built):
    rocket, _ = built
    assert rocket.warnings == []
