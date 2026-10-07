"""Nothing burns unless both propellants reach the chamber.

A one-sided flow used to be evaluated at mixture ratio zero, which the c* table
clamps to its leanest point: on the ethalox stand, the step after the LOX tank
ran dry read 3,480 N from fuel alone. Checked against what happens in a
chamber: one liquid passing through the throat is not combustion, so the
chamber is at ambient and makes no thrust -- for the CEA chamber and for an
engine card alike.
"""

from __future__ import annotations

import pytest

from feedtwin.engine.chamber import MIN_CHAMBER_FLOW, Chamber, CombustionState


class _Table:
    """c* 1500 m/s and Cf 1.5 at any pressure and any O/F -- including zero,
    which is what made a fuel-only flow burn."""

    def combustion(self, pressure: float, mixture_ratio: float) -> CombustionState:
        return CombustionState(cstar=1500.0, thrust_coefficient=1.5)


@pytest.fixture
def chamber() -> Chamber:
    return Chamber(throat_area=4.0e-4, cstar_model=_Table())


def test_both_propellants_burn(chamber: Chamber) -> None:
    lit = chamber.evaluate(1.9, 1.1)
    assert lit.thrust > 5000.0
    assert lit.pressure > 10 * chamber.ambient_pressure


@pytest.mark.parametrize("ox, fuel", [(0.0, 1.8), (1.9, 0.0), (MIN_CHAMBER_FLOW, 1.8)])
def test_one_propellant_alone_is_unlit(
    chamber: Chamber, ox: float, fuel: float
) -> None:
    result = chamber.evaluate(ox, fuel)
    assert result.thrust == 0.0
    assert result.specific_impulse == 0.0
    assert result.pressure == chamber.ambient_pressure
    assert result.mdot_total == pytest.approx(ox + fuel), "the liquid still leaves"
