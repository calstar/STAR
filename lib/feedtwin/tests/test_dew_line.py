"""A gas node the enthalpy walk lands on its own saturation line.

Venting nitrogen off a chilled LOX tank throttled it down to 77.87 K at
107.6 kPa -- nitrogen's boiling point there. The walk solved T(p, h) to exactly
that, the next solve asked for the line's properties at (p, T) on the
saturation curve, the property layer refused (liquid or vapour is not said),
and every solve failed on its first evaluation: 328 ticks of a stand that did
not move, in Vent, on LE4 (6) with the cart drawn (2026-10-12).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from feedtwin.props import Fluid, PropertyError
from feedtwin.session.core import _DEW_MARGIN_K, Session

N2 = Fluid("nitrogen")
P = 107613.0


def _land(quality: float) -> tuple[float, float, list[str]]:
    h = N2.get("h", p=P, q=quality)
    landed = N2.get("T", p=P, h=h)
    holder = SimpleNamespace(assumptions=[])
    held = Session._off_the_dew_line(holder, N2, P, h, landed, "n")  # type: ignore[arg-type]
    return landed, held, holder.assumptions


def test_the_line_itself_is_refused() -> None:
    """The hazard: on the saturation curve a (p, T) state is not a state."""
    on_the_line = N2.get("T", p=P, q=1.0)
    with pytest.raises(PropertyError):
        N2.get("rho", p=P, T=on_the_line)


def test_a_mostly_vapour_landing_is_held_as_vapour_off_the_line() -> None:
    landed, held, notes = _land(0.9)
    dew = N2.get("T", p=P, q=1.0)
    assert landed == pytest.approx(dew, abs=1e-6), "the walk lands on the line"
    assert held == pytest.approx(dew + _DEW_MARGIN_K)
    assert N2.get("rho", p=P, T=held) < 10.0, "a vapour, and one the layer serves"
    assert len(notes) == 1


def test_a_flashing_liquid_and_a_dry_gas_are_left_alone() -> None:
    landed, held, notes = _land(0.1)
    assert held == landed and not notes
    h_warm = N2.get("h", p=P, T=150.0)
    holder = SimpleNamespace(assumptions=[])
    assert Session._off_the_dew_line(holder, N2, P, h_warm, 150.0, "n") == 150.0  # type: ignore[arg-type]
    assert not holder.assumptions


def test_a_gas_line_on_its_dew_point_is_priced_as_vapour() -> None:
    """The same state reached another way -- a chilled LOX tank's nitrogen
    ullage at 2.72 bar and 86.83 K, seeding its press line (Ethalox Stand,
    13 s of failed solves in Vent)."""
    from feedtwin.comps.elements import DEW_POINT_MARGIN_K, conditions_from_fluid

    p = 271961.0
    on_the_line = N2.get("T", p=p, q=1.0)
    conditions = conditions_from_fluid(N2, p, on_the_line, phase="gas")
    assert conditions.temperature == pytest.approx(on_the_line + DEW_POINT_MARGIN_K)
    assert conditions.rho == pytest.approx(N2.get("rho", p=p, q=1.0), rel=0.01)
    warm = conditions_from_fluid(N2, p, 150.0, phase="gas")
    assert warm.temperature == 150.0
