"""T-0 is an initial condition, and the study has to reach it.

Two defects hid here, both read as physics on the trace. A LOX tank primed
without its own vapour boiled 15 psi of oxygen onto a locked-up ullage; and gas
sloshing between the two primed tanks through the shared press manifold was
priced at the *bottle's* enthalpy rather than the other tank's, which for
helium pumps energy in on every exchange. Together they held the helium study
20 psi above lockup with nothing flowing through the regulator.
"""

from __future__ import annotations

import pytest

import backend.main as api
from backend import study
from backend.assembly import engine_from_bytes
from backend.main import _cea_for
from backend.run import psig
from tests.test_session_api import an_engine


def all_thermal(gas: str):
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
        collapse=True,
        vapour=True,
        chilldown=50.0,
        line_walls=False,
    )


class TestWhatArrivesIsPricedAtItsSource:
    def test_the_walked_arrival_wins_even_with_the_walls_off(self) -> None:
        """The gate on `line_walls` was the bug: off, every gram reaching an
        ullage was priced as if it had left the bottle, including the grams
        that came from the other tank."""
        session = all_thermal("gn2")
        assert not session.setup.line_walls
        sim = next(iter(session.tanks.values()))
        session.arriving_enthalpy[sim.ullage_node] = 12345.0
        assert session._pressurant_enthalpy(sim) == 12345.0

    def test_a_node_nothing_reached_falls_back_to_the_bottle(self) -> None:
        session = all_thermal("gn2")
        sim = next(iter(session.tanks.values()))
        session.arriving_enthalpy.clear()
        bottle = session._bottle_for(sim)
        assert bottle is not None
        expected = bottle.volume.enthalpy(bottle.state)
        assert session._pressurant_enthalpy(sim) == pytest.approx(expected)


class TestTheStudyReachesLockup:
    """The symptom, guarded directly. Slow: helium's coupling step is ~1 ms."""

    @pytest.mark.parametrize("gas", ["gn2", "he"])
    def test_every_thermal_model_on_settles_at_lockup(self, gas: str) -> None:
        session = all_thermal(gas)
        notes = [a for a in session.assumptions if "did not settle" in a]
        assert notes == [], notes
        for sim in session.tanks.values():
            assert abs(psig(sim.pressure) - study.TANK_PSI) < study.SETTLE_BAND, (
                sim.id,
                psig(sim.pressure),
            )
            # Primed at 293 K and settled for two seconds: the ullage has not
            # been pumped anywhere by gas priced at the wrong enthalpy.
            assert abs(sim.tank.gas_temperature(sim.state) - 293.15) < 8.0
