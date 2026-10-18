"""Beyond the c* table's O/F range, only what can burn makes chamber pressure.

An Engine Abort vented the fuel tank while the LOX tank stayed pressed; the
engine ran LOX-rich at O/F 20-70, the c* table clamped to its edge (O/F ~4)
and priced the whole flow at that hot c*, the chamber sat at the fuel tank's
own pressure, and the fuel line flowed backwards on every other step -- liquid
"from nowhere" into the fuel tank for four seconds (Ethalox Stand, 2026-10-12).
The rule extends :func:`unlit` (a lone propellant passes through unburned).
"""

from __future__ import annotations

import pytest

from feedtwin.engine.chamber import Chamber, burning

RANGE = (1.0, 4.0)


def test_inside_the_range_everything_burns() -> None:
    assert burning(2.0, 1.0, RANGE) == 3.0
    assert burning(4.0, 1.0, RANGE) == pytest.approx(5.0), "at the edge"
    assert burning(5.0, 1.0, None) == 6.0, "no table, no range"


def test_beyond_it_the_scarce_side_burns_at_the_edge() -> None:
    assert burning(20.0, 1.0, RANGE) == pytest.approx(5.0), "lean: fuel x (1 + 4)"
    assert burning(0.5, 1.0, RANGE) == pytest.approx(1.0), "rich: ox x (1 + 1)"


def test_it_is_continuous_and_goes_to_unlit() -> None:
    edge = burning(4.0, 1.0, RANGE)
    assert burning(4.0 + 1e-9, 1.0, RANGE) == pytest.approx(edge)
    assert burning(1.0, 1e-6, RANGE) == pytest.approx(5e-6), "fuel gone, nothing burns"


class _Flat:
    """A c* table: constant c*, a range, clamped like the real one."""

    mixture_ratios = (1.0, 4.0)

    def combustion(self, pressure: float, mixture_ratio: float):  # type: ignore[no-untyped-def]
        from feedtwin.engine.chamber import CombustionState

        return CombustionState(cstar=1600.0, thrust_coefficient=1.5)


def test_a_lox_rich_abort_does_not_hold_the_chamber_at_the_hot_cstar(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import feedtwin.engine.chamber as module

    monkeypatch.setattr(module, "CEATable", _Flat)
    chamber = Chamber(throat_area=5e-4, cstar_model=_Flat())  # type: ignore[arg-type]
    rich = chamber.evaluate(mdot_oxidiser=2.0, mdot_fuel=0.05)
    burned = 0.05 * (1.0 + 4.0)
    assert rich.pressure == pytest.approx(burned * 1600.0 / 5e-4)
    clamped = 2.05 * 1600.0 / 5e-4
    assert rich.pressure < 0.2 * clamped
