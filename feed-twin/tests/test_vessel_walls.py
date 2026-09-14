"""Vessel walls come from the drawing, or from a stated, scaled default.

Three bare numbers -- 8 / 900 / 12 for every tank, 30 / 500 / 20 for every
bottle -- were applied whatever the vessel's size, so a 4.7 L cylinder was
given a 44 L K-bottle's wall. The wall is the term that decides how much a
bottle cools on blowdown, so this was the largest unprovenanced input on the
stand.
"""

from __future__ import annotations

import pytest

from backend.session import BOTTLE_WALL, TANK_WALL, _vessel_wall
from feedtwin.model.param import Param, Provenance


class _Node:
    def __init__(self, label: str, **params: Param) -> None:
        self.id = label
        self.label = label
        self.params = params


def test_declared_walls_win_and_leave_no_assumption() -> None:
    notes: list[str] = []
    node = _Node(
        "KB1",
        wall_mass=Param(3.5, "kg", Provenance.ESTIMATED, "weighed"),
        wall_capacity=Param(850.0, "J/(kg.K)", Provenance.ESTIMATED, "Al + carbon"),
        wall_conductance=Param(20.0, "W/K", Provenance.ESTIMATED, "film estimate"),
    )
    mass, cp, ha = _vessel_wall(node, 4.687e-3, BOTTLE_WALL, notes)
    assert (mass, cp, ha) == (3.5, 850.0, 20.0)
    assert notes == []


def test_defaults_scale_with_volume_and_are_reported() -> None:
    """Mass per litre, conductance as V^(2/3): a bigger vessel has more wall
    and more area, and a drawing that says nothing is told what was assumed."""
    small_notes: list[str] = []
    big_notes: list[str] = []
    m1, c1, h1 = _vessel_wall(_Node("A"), 4.687e-3, BOTTLE_WALL, small_notes)
    m2, c2, h2 = _vessel_wall(_Node("B"), 44.0e-3, BOTTLE_WALL, big_notes)
    assert m2 / m1 == pytest.approx(44.0 / 4.687, rel=1e-9)
    assert h2 / h1 == pytest.approx((44.0 / 4.687) ** (2.0 / 3.0), rel=1e-9)
    assert c1 == c2 == BOTTLE_WALL["capacity"]
    assert m2 == pytest.approx(60.0, rel=1e-9), "a 44 L steel K-bottle is ~60 kg"
    assert len(small_notes) == 1 and "wall_mass" in small_notes[0]


def test_a_partly_declared_wall_keeps_what_it_knows() -> None:
    """A weighed vessel with no idea of its film coefficient still gets credit
    for the mass; only the missing pieces are estimated and named."""
    notes: list[str] = []
    node = _Node("T1", wall_mass=Param(6.0, "kg", Provenance.MEASURED, "scale"))
    mass, cp, ha = _vessel_wall(node, 17.5e-3, TANK_WALL, notes)
    assert mass == 6.0
    assert cp == TANK_WALL["capacity"]
    assert ha == pytest.approx(12.0)
    assert "wall_capacity" in notes[0] and "wall_conductance" in notes[0]
    assert "wall_mass" not in notes[0].split(";")[0]


def test_the_old_tank_numbers_are_recovered_at_the_volume_they_were_written_for() -> (
    None
):
    """8 kg, 900 J/(kg.K), 12 W/K at 17.5 L -- so an existing 17.5 L drawing
    is unchanged by this becoming a scaled default."""
    mass, cp, ha = _vessel_wall(_Node("T"), 17.5e-3, TANK_WALL, [])
    assert (round(mass, 6), cp, round(ha, 6)) == (8.0, 900.0, 12.0)
