"""Phase 2 of the pid-designer overhaul, on the cockpit side.

A vessel trips at its burst pressure over a factor of safety; its gas-to-wall
film comes from its gas when the drawing leaves it blank; both are stated as
assumptions and both give way to a number on the drawing.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from backend.run import ATMOSPHERE, PSI
from backend.session import TANK_WALL, _trip_limit, _vessel_wall
from feedtwin.model.param import Param, Provenance
from feedtwin.vessels.convection import GasFilm


@dataclass
class _Node:
    id: str
    label: str = ""
    params: dict = field(default_factory=dict)


def _psi(value: float) -> Param:
    return Param(value * PSI, "Pa", Provenance.MANUFACTURER, "test")


class TestTripLimit:
    def test_burst_over_the_factor_of_safety(self) -> None:
        notes: list[str] = []
        limit = _trip_limit(
            _Node("TK", "TK-OX", {"burst_pressure": _psi(1500.0)}), 2.0, notes
        )
        assert limit == pytest.approx(750.0 * PSI + ATMOSPHERE)
        assert any("burst pressure / 2" in n for n in notes)

    def test_a_legacy_mawp_still_trips(self) -> None:
        limit = _trip_limit(_Node("TK", params={"MAWP": _psi(800.0)}), 2.0, [])
        assert limit == pytest.approx(800.0 * PSI + ATMOSPHERE)

    def test_burst_beats_mawp_when_both_are_there(self) -> None:
        node = _Node("TK", params={"MAWP": _psi(800.0), "burst_pressure": _psi(1500.0)})
        assert _trip_limit(node, 2.0, []) == pytest.approx(750.0 * PSI + ATMOSPHERE)

    def test_no_rating_means_no_trip(self) -> None:
        assert _trip_limit(_Node("TK"), 2.0, []) == 0.0

    def test_a_factor_below_one_is_not_honoured(self) -> None:
        # A safety factor under one would trip *above* burst. Clamped.
        limit = _trip_limit(
            _Node("TK", params={"burst_pressure": _psi(1000.0)}), 0.5, []
        )
        assert limit == pytest.approx(1000.0 * PSI + ATMOSPHERE)


class TestFilmEstimate:
    def _film(self, hA: float) -> GasFilm:
        return GasFilm(
            hA=hA,
            h=hA / 0.5,
            area=0.5,
            grashof=1e8,
            prandtl=0.7,
            nusselt=50.0,
            delta_T=10.0,
        )

    def test_blank_takes_the_estimate_and_says_so(self) -> None:
        notes: list[str] = []
        _, _, hA = _vessel_wall(
            _Node("TK", "TK-1"),
            17.5e-3,
            TANK_WALL,
            notes,
            estimate=lambda: self._film(21.5),
        )
        assert hA == pytest.approx(21.5)
        assert any("estimated from its gas" in n for n in notes)

    def test_a_value_on_the_drawing_wins(self) -> None:
        node = _Node(
            "TK",
            params={
                "wall_conductance": Param(9.0, "W/K", Provenance.MEASURED, "bench")
            },
        )
        _, _, hA = _vessel_wall(
            node, 17.5e-3, TANK_WALL, [], estimate=lambda: self._film(21.5)
        )
        assert hA == 9.0

    def test_no_estimator_is_todays_behaviour(self) -> None:
        # The library default, exactly: the per-litre figure scaled as V^(2/3).
        _, _, hA = _vessel_wall(_Node("TK"), 17.5e-3, TANK_WALL, [])
        ha_ref, litres_ref = TANK_WALL["hA_ref"]
        assert hA == pytest.approx(ha_ref * (17.5 / litres_ref) ** (2.0 / 3.0))

    def test_a_failed_estimate_falls_back_and_says_so(self) -> None:
        notes: list[str] = []

        def boom() -> GasFilm:
            raise RuntimeError("no properties")

        _, _, hA = _vessel_wall(
            _Node("TK", "TK-1"), 17.5e-3, TANK_WALL, notes, estimate=boom
        )
        assert hA > 0.0
        assert any("could not be estimated" in n for n in notes)
