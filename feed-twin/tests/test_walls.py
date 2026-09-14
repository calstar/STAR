"""Phase 15 in the session: what the line walls do to a running stand.

The library tests cover the exchange itself. These cover the three things that
can only go wrong once it is wired into a session -- where the metal starts,
whether the joules balance over a burn, and whether the tank actually feels it.

The first test is the one that matters most. A physics option that changes the
default answer is not an option.
"""

from __future__ import annotations

import pytest

from backend.main import _cea_for, engine_from_bytes
import backend.main as api
import backend.study as study
from feedtwin.comps.wall import stainless_capacity

from tests.test_session_api import an_engine


def a_stand(*, walls: bool, gas: str = "gn2"):
    engine_id = an_engine()
    if study.find_diagram(api.library, gas) is None:
        pytest.skip(f"no {gas} study drawing")
    design = engine_from_bytes(api.library.path(engine_id).read_bytes(), name="e")
    return study._stand(
        api.library,
        gas,
        engine_id,
        _cea_for(design),
        litres=None,
        collapse=False,
        line_walls=walls,
    )


def burn(session, ticks: int = 40, dt: float = 0.05) -> list[float]:
    session.state = "Fire"
    out = []
    for _ in range(ticks):
        session.step(dt)
        out.append(session.tanks["OXT"].pressure)
    return out


class TestOffIsOff:
    def test_the_toggle_off_changes_nothing(self) -> None:
        """`_pressurant_enthalpy` learned to read what the walk delivered rather
        than what left the bottle. Off, it must still read the bottle: an
        adiabatic path conserves enthalpy so the two agree to within the walk's
        convergence tolerance, and "agrees to a tolerance" is not "unchanged".
        """
        assert burn(a_stand(walls=False)) == burn(a_stand(walls=False))

    def test_no_metal_on_the_drawing_means_no_effect(self) -> None:
        """A line with no `wall_thickness` and no `fitting_mass` has no metal to
        give, so the toggle is inert on a drawing that never declared any --
        which is every drawing anybody has made until now.
        """
        session = a_stand(walls=True)
        for wall in session.walls.values():
            wall.mass  # built from the drawing
        stripped = a_stand(walls=True)
        stripped.walls.clear()
        stripped.wall_temperature.clear()
        assert burn(stripped) == burn(a_stand(walls=False))


class TestWhereTheMetalStarts:
    """The architectural question: a LOX line is cold, the line above the liquid
    is cool, and the pressurant line is at room temperature -- and none of that
    may need a soak model to know.
    """

    def test_a_lox_line_starts_at_lox_temperature(self) -> None:
        session = a_stand(walls=True)
        liquid = session.tanks["OXT"].state.liquid_temperature
        for line in ("l_ox1", "l_ox2", "l_oxfill"):
            assert session.wall_temperature[line] == pytest.approx(
                liquid, abs=2.0
            ), f"{line} holds LOX at rest, so its metal is at LOX temperature"

    def test_a_line_off_the_ullage_starts_at_the_ullage(self) -> None:
        """Not at liquid temperature. The vent line leaves the *top* of the
        tank, so what stands in it is ullage gas -- which is the distinction
        that made the wall seed from the settled walk rather than from whatever
        the drawing was built with, where the tank node still read as liquid.
        """
        session = a_stand(walls=True)
        tank = session.tanks["OXT"]
        ullage = tank.tank.gas_temperature(tank.state)
        assert session.wall_temperature["l_oxvent"] == pytest.approx(ullage, abs=2.0)
        assert session.wall_temperature["l_oxvent"] > tank.state.liquid_temperature + 50

    def test_the_pressurant_side_starts_warm(self) -> None:
        session = a_stand(walls=True)
        for line in ("l_kb", "l_reg", "l_reg_out", "l_oxpress"):
            assert session.wall_temperature[line] > 280.0

    def test_every_wall_is_seeded_before_it_is_used(self) -> None:
        session = a_stand(walls=True)
        assert set(session.wall_temperature) == set(session.walls)
        assert all(t > 0.0 for t in session.wall_temperature.values())


class TestTheJoulesBalance:
    def test_heat_into_the_gas_equals_heat_out_of_the_metal(self) -> None:
        """The one test that would catch a wall inventing energy. Integrate what
        every line gave over a burn and compare it against the metal's own
        cp.dT; they close to a couple of percent, which is the piecewise-linear
        cp evaluated at a midpoint rather than integrated.
        """
        session = a_stand(walls=True)
        start = dict(session.wall_temperature)
        given: dict[str, float] = {}
        walk = session._propagate_temperatures

        def spy(pressures, flows, dt=0.0):
            before = dict(session.wall_temperature)
            walk(pressures, flows, dt)
            for line, after in session.wall_temperature.items():
                was = before.get(line)
                if was is None:
                    continue
                held = session.walls[line].mass * stainless_capacity(
                    0.5 * (was + after)
                )
                given[line] = given.get(line, 0.0) + held * (was - after)

        session._propagate_temperatures = spy  # type: ignore[method-assign]
        burn(session, ticks=80)

        joules = sum(given.values())
        assert joules > 1_000.0, "a stand's worth of metal should give real heat"
        expected = 0.0
        for line, was in start.items():
            after = session.wall_temperature[line]
            held = session.walls[line].mass * stainless_capacity(0.5 * (was + after))
            expected += held * (was - after)
        assert joules == pytest.approx(expected, rel=0.03)

    def test_the_metal_only_ever_cools_toward_the_gas(self) -> None:
        """A wall may not step past the stream it is exchanging with. Without
        the clamp a light line on a long tick overshoots, and then starts
        cooling the gas it was warming a moment ago.
        """
        session = a_stand(walls=True)
        floors = {
            line: session.tanks["OXT"].state.liquid_temperature - 1.0
            for line in session.walls
        }
        session.state = "Fire"
        for _ in range(60):
            session.step(0.05)
            for line, temperature in session.wall_temperature.items():
                assert temperature > floors[line], f"{line} fell through the stream"
                assert temperature < 400.0, f"{line} ran away upward"


class TestTheTankFeelsIt:
    def test_wall_heat_reaches_the_ullage(self) -> None:
        """The reason this is worth having at all. Warm pressurant is less dense,
        so a tank pressed with gas the lines have warmed needs fewer kilograms
        to hold its pressure -- and holds it longer out of the same bottle.
        """
        cold = burn(a_stand(walls=False), ticks=120)
        warmed = burn(a_stand(walls=True), ticks=120)
        assert (
            warmed[-1] > cold[-1] + 5.0
        ), f"walls should hold the tank up: {cold[-1]:.1f} -> {warmed[-1]:.1f} psi"

    def test_the_bottle_lasts_longer(self) -> None:
        cold, warmed = a_stand(walls=False), a_stand(walls=True)
        for session in (cold, warmed):
            burn(session, ticks=120)
        left = [next(iter(s.bottles.values())).pressure for s in (cold, warmed)]
        assert (
            left[1] > left[0]
        ), f"COPV should end fuller: {left[0]:.0f} -> {left[1]:.0f}"
