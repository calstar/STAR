"""The upper (ullage) wall's temperature at T-0 (``Setup.ullage_wall_T0_K``).

``Session.prime`` builds a loaded tank's upper wall at the pressurant's 293.15 K.
A LOX tank that has held its load has a cold upper shell, and that costs bottle
(EngineDesign/docs/layerx/AUDIT.md D1). The setting moves only that wall, per
tank; empty, the primed state is what it always was.

The physics check is closed form: over a short hold with every valve shut, the
extra cooling of the ullage gas is the wall's film, ``m cv dT = -hA (T_gas -
T_wall) dt``, with the session's own ``hA`` -- the setting reaches the vessel the
thermal model integrates, not just a field.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from feedtwin.pid import read_diagram
from feedtwin.session import Setup, assemble_model, load_machine
from feedtwin.session.burn import burn_setup, open_session
from feedtwin.session.gauge import from_psig

STAR = Path(__file__).resolve().parents[3]
STAND = STAR / "feed-twin" / "backend" / "diagrams" / "ethalox_stand.json"
TABLES = STAR / "feed-twin" / "backend" / "statemachines"

pytestmark = pytest.mark.skipif(
    not (STAND.exists() and TABLES.is_dir()), reason="stand drawing or tables absent"
)


def _primed(**setup):  # type: ignore[no-untyped-def]
    model = assemble_model(
        read_diagram(json.loads(STAND.read_text()), name="ethalox_stand"),
        diagram_id="ethalox_stand.json",
    )
    session = open_session(
        model, load_machine(tables=TABLES), setup=burn_setup(**setup)
    )
    session.prime(tank_psi=550.0, copv_psi=4500.0, state="Ready")
    return session


def test_off_by_default() -> None:
    assert dict(Setup().ullage_wall_T0_K) == {}
    assert Setup().cryogen_ullage_wall_T0_K == 0.0


def test_default_prime_is_the_old_initial_state() -> None:
    """Every tank exactly as ``Tank.initial_state`` built it before the setting."""
    session = _primed()
    for sim in session.tanks.values():
        rho = sim.tank.liquid.get("rho", T=sim.state.liquid_temperature, q=0.0)
        expected = sim.tank.initial_state(
            pressure=from_psig(550.0),
            liquid_mass=sim.tank.geometry.total_volume * 0.95 * rho,
            liquid_temperature=sim.state.liquid_temperature,
            gas_temperature=293.15,
            contact_time=300.0,
            split_wall=True,
        )
        assert sim.state == expected, sim.id
    assert not any("upper wall at T-0" in note for note in session.assumptions)


def test_per_tank_moves_only_that_wall() -> None:
    base = _primed()
    cold = _primed(ullage_wall_T0_K={"OXT": 150.0})
    lox, lox0 = cold.tanks["OXT"].state, base.tanks["OXT"].state
    assert lox.ullage.wall_temperature == 150.0
    assert lox.ullage.mass == lox0.ullage.mass
    assert lox.ullage.energy == lox0.ullage.energy
    assert lox.wetted_wall_temperature == lox0.wetted_wall_temperature
    assert cold.tanks["FUT"].state == base.tanks["FUT"].state
    assert any("TK-LOX" in n or "upper wall" in n for n in cold.assumptions)


def test_the_cryogen_dial_and_the_per_tank_map() -> None:
    dial = _primed(cryogen_ullage_wall_T0_K=170.0)
    assert dial.tanks["OXT"].state.ullage.wall_temperature == 170.0
    # The fuel tank holds ethanol at room temperature: not a cryogen.
    assert dial.tanks["FUT"].state.ullage.wall_temperature == 293.15
    both = _primed(cryogen_ullage_wall_T0_K=170.0, ullage_wall_T0_K={"OXT": 120.0})
    assert both.tanks["OXT"].state.ullage.wall_temperature == 120.0


def test_a_cold_upper_wall_cools_the_ullage_at_its_film_rate() -> None:
    """0.1 s shut in, wall at 150 K against gas at 293 K: the gas cools by
    hA mean(T_gas - T_wall) t / (m cv) more than with the warm wall."""
    hold, step = 0.1, 0.02
    warm, cold = _primed(), _primed(ullage_wall_T0_K={"OXT": 150.0})
    sim = cold.tanks["OXT"]
    start = sim.state
    T0 = sim.tank.gas_temperature(start)
    cv = sim.tank.gas.get("cv", p=sim.pressure, T=T0)
    for session in (warm, cold):
        for _ in range(int(round(hold / step))):
            session.step(step)
    T_warm = warm.tanks["OXT"].tank.gas_temperature(warm.tanks["OXT"].state)
    T_cold = sim.tank.gas_temperature(sim.state)
    gap = 0.5 * (
        (T0 - start.ullage.wall_temperature)
        + (T_cold - sim.state.ullage.wall_temperature)
    )
    hand = sim.tank.wall_conductance * gap * hold / (start.ullage.mass * cv)
    assert T_warm - T_cold == pytest.approx(hand, rel=0.05)
    # And the tank sags: the gas it holds is colder.
    assert cold.tanks["OXT"].pressure < warm.tanks["OXT"].pressure - 5.0 * 6894.757
