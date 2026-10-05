"""Liquid columns feel the vehicle's acceleration, not standard gravity.

On a stand every head is ``rho * g0 * dz``. In flight the column feels the
proper acceleration along the vehicle axis -- thrust less drag over mass, what
an accelerometer reads -- which is ~7 g on the 6.8 kN vehicle at burnout. The
heads are arithmetic, so the checks are by hand. The default is standard
gravity, and a session that does not set it runs exactly as it did.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from feedtwin.comps import FlowConditions, build_component
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.pid import read_diagram
from feedtwin.session import Setup, assemble_model, load_machine
from feedtwin.session.burn import burn_setup, open_session
from feedtwin.solve.network import Network
from feedtwin.vessels.volume import GRAVITY

M = Provenance.MANUFACTURER
STAR = Path(__file__).resolve().parents[3]
STAND = STAR / "feed-twin" / "backend" / "diagrams" / "ethalox_stand.json"
TABLES = STAR / "feed-twin" / "backend" / "statemachines"
needs_stand = pytest.mark.skipif(
    not (STAND.exists() and TABLES.is_dir()), reason="stand drawing or tables absent"
)

#: Seven standard gravities, the order of the vehicle's acceleration at burnout.
SEVEN_G = 7.0 * 9.80665


def test_the_default_is_standard_gravity_exactly() -> None:
    assert GRAVITY == 9.80665
    assert Setup().body_acceleration == GRAVITY
    assert FlowConditions(rho=1.0, mu=1.0, p_upstream=1.0).gravity == GRAVITY
    assert Network().gravity == GRAVITY


def test_a_line_climb_carries_rho_a_h() -> None:
    climb = 2.5
    line = build_component(
        ComponentInstance.build(
            "FL-01",
            "pipe",
            {
                "length": Param(3.0, "m", M, "test"),
                "bore": Param(10.0, "mm", M, "test"),
                "elevation_change": Param(climb, "m", M, "test"),
            },
        )
    )
    flow = FlowConditions(rho=789.0, mu=1.1e-3, p_upstream=4.0e6, gravity=SEVEN_G)
    assert line.static_head(flow) == pytest.approx(789.0 * SEVEN_G * climb, rel=1e-12)


@needs_stand
def test_a_session_puts_its_acceleration_on_every_column() -> None:
    def session(setup: Setup):  # type: ignore[no-untyped-def]
        diagram = read_diagram(json.loads(STAND.read_text()), name="ethalox_stand")
        model = assemble_model(diagram, diagram_id="ethalox_stand.json")
        s = open_session(model, load_machine(tables=TABLES), setup=setup)
        s.prime(tank_psi=500.0, copv_psi=4500.0)
        s.step(0.02)
        return s

    flying = session(burn_setup(body_acceleration=SEVEN_G))
    net = flying.model.built.network
    assert net.gravity == SEVEN_G
    # What every line's static head is computed with: the conditions the network hands out.
    node = next(iter(net.nodes))
    assert net.conditions(node, 1.0e6).gravity == SEVEN_G
    for sim in flying.tanks.values():
        rho = sim.tank.liquid_density(sim.state)
        level = sim.tank.level(sim.state)
        assert level > 0.05
        assert sim.outlet_pressure - sim.pressure == pytest.approx(
            rho * SEVEN_G * level, rel=1e-12
        )

    standing = session(burn_setup())
    assert standing.model.built.network.gravity == GRAVITY
    for sim in standing.tanks.values():
        rho = sim.tank.liquid_density(sim.state)
        level = sim.tank.level(sim.state)
        assert sim.outlet_pressure - sim.pressure == pytest.approx(
            rho * GRAVITY * level, rel=1e-12
        )
