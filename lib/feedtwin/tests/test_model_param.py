"""Provenance is mandatory, and survives a round trip.

Phase 02's headline exit criterion is that *a parameter with no source is a
validation error rather than a default*. That is what these tests hold. The rest
check that the record survives serialisation intact, because provenance that is
lost on the first save is provenance that does not exist.
"""

from __future__ import annotations

import json

import pytest

from feedtwin.model import (
    Param,
    Provenance,
    Uncertainty,
    assumed_params,
    provenance_summary,
)
from feedtwin.model.units import UnknownUnit


def test_a_parameter_with_no_source_is_rejected() -> None:
    """The criterion, stated directly.

    A missing source must not default to anything -- not to ESTIMATED, not to
    DEFAULT. Defaulting it would mean every un-sourced number silently acquired
    a plausible-looking provenance, which is worse than having none at all.
    """
    with pytest.raises(ValueError, match="missing required field"):
        Param.from_dict({"value": 1.2, "unit": "Cv"}, where="valve.Cv")


def test_a_source_must_be_one_of_the_declared_kinds() -> None:
    with pytest.raises(ValueError, match="not a valid source"):
        Param.from_dict(
            {"value": 1.0, "unit": "m", "source": "vibes"}, where="pipe.bore"
        )


def test_the_source_must_be_the_enum_not_a_string() -> None:
    """Constructed directly, a stringly-typed source is a type error."""
    with pytest.raises(TypeError, match="must be a Provenance"):
        Param(1.0, "m", "manufacturer")  # type: ignore[arg-type]


def test_an_unknown_unit_is_caught_at_construction() -> None:
    with pytest.raises(UnknownUnit):
        Param(1.0, "smoots", Provenance.ESTIMATED)


def test_value_is_stored_as_authored_and_converted_on_demand() -> None:
    """Round-trip fidelity depends on keeping the authored form.

    Converting on construction would mean a config written in psi came back as
    a float with a trail of decimals -- a diff on every save, and a file that no
    longer looks like what someone wrote.
    """
    p = Param(500.0, "psi", Provenance.MANUFACTURER, "MEOP")
    assert p.value == 500.0
    assert p.unit == "psi"
    assert p.si == pytest.approx(3447378.6, rel=1e-6)
    assert p.dimension == "pressure"


def test_round_trip_through_json_is_exact() -> None:
    """A parameter survives the full save/load path unchanged."""
    original = Param(
        value=1.2,
        unit="Cv",
        source=Provenance.MANUFACTURER,
        reference="SS-8BK-V51 datasheet rev C, table 2",
        uncertainty=Uncertainty("relative", 0.10),
    )
    restored = Param.from_dict(json.loads(json.dumps(original.to_dict())))
    assert restored == original


def test_optional_fields_are_omitted_rather_than_nulled() -> None:
    """A terse parameter stays terse when written back."""
    data = Param(1.0, "m", Provenance.DEFAULT).to_dict()
    assert set(data) == {"value", "unit", "source"}


def test_uncertainty_bounds() -> None:
    relative = Uncertainty("relative", 0.10)
    assert relative.bounds(100.0) == pytest.approx((90.0, 110.0))

    absolute = Uncertainty("absolute", 5.0)
    assert absolute.bounds(100.0) == pytest.approx((95.0, 105.0))

    # Relative uncertainty on a negative value still widens the interval.
    assert relative.bounds(-100.0) == pytest.approx((-110.0, -90.0))


@pytest.mark.parametrize("kind", ["percent", "", "Relative"])
def test_uncertainty_kind_is_checked(kind: str) -> None:
    with pytest.raises(ValueError, match="relative|absolute"):
        Uncertainty(kind, 0.1)


def test_uncertainty_cannot_be_negative() -> None:
    with pytest.raises(ValueError, match="non-negative"):
        Uncertainty("relative", -0.1)


def test_si_bounds_are_in_canonical_units() -> None:
    p = Param(100.0, "psi", Provenance.MEASURED, "PT-04", Uncertainty("relative", 0.01))
    low, high = p.si_bounds() or (0.0, 0.0)
    assert low == pytest.approx(p.si * 0.99)
    assert high == pytest.approx(p.si * 1.01)
    assert Param(1.0, "m", Provenance.DEFAULT).si_bounds() is None


def test_provenance_is_ranked_so_measurements_win() -> None:
    assert Provenance.MEASURED.rank > Provenance.MANUFACTURER.rank
    assert Provenance.MANUFACTURER.rank > Provenance.ESTIMATED.rank
    assert Provenance.ESTIMATED.rank > Provenance.DEFAULT.rank


def test_assumed_flags_the_values_nobody_established() -> None:
    assert Provenance.ESTIMATED.is_assumed
    assert Provenance.DEFAULT.is_assumed
    assert not Provenance.MEASURED.is_assumed
    assert not Provenance.MANUFACTURER.is_assumed


def test_a_report_can_say_what_a_result_rests_on() -> None:
    """The point of carrying provenance at all.

    "Nine measured, four datasheet, two guesses" is a different claim from a
    bare number, and the difference should never be invisible in a design
    review.
    """
    params = {
        "a": Param(1.0, "m", Provenance.MEASURED, "CF-2026-03"),
        "b": Param(2.0, "m", Provenance.MANUFACTURER, "datasheet"),
        "c": Param(3.0, "m", Provenance.ESTIMATED, "similar part"),
        "d": Param(4.0, "m", Provenance.DEFAULT, "library default"),
    }
    assert provenance_summary(params) == {
        "measured": 1,
        "manufacturer": 1,
        "estimated": 1,
        "default": 1,
    }
    assert assumed_params(params) == ["c", "d"]


def test_summary_always_reports_every_kind() -> None:
    """A stable table, so a report does not gain and lose columns."""
    assert set(provenance_summary({})) == {p.value for p in Provenance}
