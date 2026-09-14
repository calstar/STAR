"""Unit conversion, and the dimension check that catches the expensive mistake.

Unit confusion is the most costly recurring error in this field and the easiest
to prevent, provided the prevention sits at a boundary rather than in everyone's
memory. These tests hold that boundary.

Conversion factors are checked against exact definitions where one exists --
an inch is 0.0254 m by definition, not by measurement -- so a typo in a factor
fails rather than shifting every result by a fraction of a percent.
"""

from __future__ import annotations

import pytest

from feedtwin.model.units import (
    DimensionMismatch,
    UnknownUnit,
    check_dimension,
    dimension_of,
    from_si,
    register_unit,
    registered_units,
    si_unit_of,
    to_si,
)

#: (value, unit, expected SI). Exact definitions where they exist.
CONVERSIONS = [
    (1.0, "in", 0.0254),  # defined exactly
    (12.0, "in", 0.3048),  # one foot
    (1.0, "ft", 0.3048),
    (1.0, "mm", 1e-3),
    (1.0, "psi", 6894.757293168361),
    (1.0, "bar", 1e5),
    (1.0, "atm", 101325.0),  # defined exactly
    (1.0, "lbm", 0.45359237),  # defined exactly
    (1.0, "gal", 3.785411784e-3),  # defined exactly
    (1.0, "L", 1e-3),
    (1.0, "min", 60.0),
    (1.0, "cP", 1e-3),
]


@pytest.mark.parametrize("value,unit,expected", CONVERSIONS)
def test_conversion_to_si(value: float, unit: str, expected: float) -> None:
    assert to_si(value, unit) == pytest.approx(expected, rel=1e-12)


@pytest.mark.parametrize("value,unit,_expected", CONVERSIONS)
def test_conversion_round_trips(value: float, unit: str, _expected: float) -> None:
    assert from_si(to_si(value, unit), unit) == pytest.approx(value, rel=1e-12)


def test_temperature_carries_an_offset() -> None:
    """The one dimension where a scale factor alone is wrong."""
    assert to_si(0.0, "degC") == pytest.approx(273.15)
    assert to_si(20.0, "degC") == pytest.approx(293.15)
    assert from_si(293.15, "degC") == pytest.approx(20.0)
    assert to_si(491.67, "degR") == pytest.approx(273.15, rel=1e-6)


def test_temperature_difference_is_a_separate_dimension() -> None:
    """A 20 K rise and a 20 K absolute temperature are not the same quantity.

    Sharing a dimension would let a temperature *difference* be written where an
    absolute temperature belongs and convert with a 273.15 offset applied -- a
    silent 273 K error in a heat balance.
    """
    assert dimension_of("K") == "temperature"
    assert dimension_of("K_diff") == "temperature_difference"
    assert to_si(20.0, "degC_diff") == pytest.approx(20.0)
    assert to_si(20.0, "degC") == pytest.approx(293.15)


def test_cv_and_kv_convert_through_the_standard_factor() -> None:
    """Cv/Kv comes from IEC 60534 via ``fluids``, not from a literal here.

    The same constant the Phase 03 valve correlations will use, so a valve
    authored in Kv and one authored in Cv cannot disagree.
    """
    from fluids.fittings import Kv_to_Cv

    assert to_si(1.0, "Kv") == pytest.approx(Kv_to_Cv(1.0), rel=1e-12)
    assert to_si(1.0, "Cv") == 1.0
    assert dimension_of("Cv") == dimension_of("Kv") == "flow_coefficient"


def test_a_wrong_dimension_is_rejected_by_name() -> None:
    """The whole point: the message says what was expected and what was given."""
    with pytest.raises(DimensionMismatch) as excinfo:
        check_dimension("psi", "length", "pipe.bore")

    message = str(excinfo.value)
    assert "pipe.bore" in message
    assert "length" in message and "pressure" in message


def test_an_unknown_unit_points_at_the_registry() -> None:
    """No close match for this one, so it should still say where to look."""
    with pytest.raises(UnknownUnit, match="registered_units"):
        to_si(1.0, "smoots")


def test_gauge_pressure_is_deliberately_not_a_unit() -> None:
    """``psig`` must not silently become an absolute pressure.

    Gauge is a *reference*, not a unit: converting it needs the ambient
    pressure, which a units table does not know. Accepting the spelling and
    treating it as absolute would put every gauge-authored pressure one
    atmosphere low -- about 15 psi, which is small enough to look plausible.
    """
    assert "psig" not in registered_units()
    with pytest.raises(UnknownUnit):
        to_si(500.0, "psig")


def test_every_dimension_has_a_canonical_unit() -> None:
    """Guards the reverse lookup used to label output.

    ``si_unit_of`` scans for the unit with factor 1.0; a dimension whose units
    all have factors would make it raise, and only at report time.
    """
    for unit in registered_units():
        assert si_unit_of(dimension_of(unit))


def test_a_unit_can_be_added_from_outside() -> None:
    register_unit("furlong", "length", 201.168)
    assert to_si(1.0, "furlong") == pytest.approx(201.168)
    assert dimension_of("furlong") == "length"
