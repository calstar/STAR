"""People read psia (ADR 0007): one formatter, and the words that use it.

Checked against arithmetic, not against the code: a standard atmosphere is
101,325 Pa and a psi is 6,894.757 Pa, so the stand's 500 psig dome is 514.696
psia and a vented tank reads 14.7. The wire keeps gauge -- :func:`psig` and
:func:`from_psig` are untouched -- and nothing here may move a number in the
model: a session's words change, not its state.
"""

from __future__ import annotations

import pytest

from feedtwin.model import pressure
from feedtwin.session import gauge
from feedtwin.session.gauge import (
    ATMOSPHERE,
    ATMOSPHERE_PSI,
    PSI,
    from_psig,
    psia,
    psig,
    say,
)


def test_the_atmosphere_is_14_696_psia() -> None:
    # 101325 / 6894.757293168361, by hand: 14.69594877551...
    assert ATMOSPHERE_PSI == pytest.approx(14.695948775513, abs=1e-12)
    assert psia(ATMOSPHERE) == pytest.approx(ATMOSPHERE_PSI, rel=1e-15)
    assert PSI == 6894.757293168361


def test_a_gauge_number_reads_an_atmosphere_higher() -> None:
    assert psia(from_psig(500.0)) == pytest.approx(514.695949, abs=1e-6)
    assert psia(from_psig(0.0)) == pytest.approx(ATMOSPHERE_PSI)
    # The wire is untouched: gauge in, gauge out.
    assert psig(from_psig(473.5)) == pytest.approx(473.5, abs=1e-12)


@pytest.mark.parametrize(
    "pascal, places, said",
    [
        (from_psig(500.0), 1, "514.7 psia"),
        (from_psig(500.0), 0, "515 psia"),
        (from_psig(4500.0), 1, "4,514.7 psia"),
        (ATMOSPHERE, 1, "14.7 psia"),
        (0.0, 0, "0 psia"),
        (-1e-6, 2, "0.00 psia"),  # a vacuum's rounding never says "-0"
        (750.0 * PSI + ATMOSPHERE, 1, "764.7 psia"),
    ],
)
def test_say_spells_a_pressure_in_psia(pascal: float, places: int, said: str) -> None:
    assert say(pascal, places) == said


def test_there_is_one_formatter() -> None:
    """The session's address is the drawing reader's function, not a copy."""
    assert gauge.say is pressure.say
    assert gauge.psia is pressure.psia


def test_a_vessel_s_trip_limit_is_said_in_psia() -> None:
    """Burst over the factor of safety is a limit across the wall: 1,500 psi of
    burst over two is 750 psi across it, which a person reads as 764.7 psia."""
    from feedtwin.model.param import Param, Provenance
    from feedtwin.session.core import _trip_limit

    class Node:
        id = "TK"
        label = "TK-OX"
        params = {
            "burst_pressure": Param(
                1500.0, "psig", Provenance.ESTIMATED, "test: a burst rating"
            )
        }

    notes: list[str] = []
    limit = _trip_limit(Node(), 2.0, notes)
    assert limit == pytest.approx(750.0 * PSI + ATMOSPHERE)
    assert notes == [
        "TK-OX trip limit: burst pressure / 2 across the wall (764.7 psia)."
    ]
