"""The parts database: resolving a part number into a configured component.

Phase 02's second exit criterion. The behaviour worth protecting beyond that is
the separation of datasheet values from measured ones: a measurement overrides
a claim without erasing it, so "this valve flows 5% under its rating" stays a
question anyone can ask later.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from feedtwin.model import (
    Catalog,
    CatalogError,
    Param,
    Part,
    Provenance,
    measured,
)

CATALOG_TOML = textwrap.dedent("""
    ["swagelok-ss-8bk-v51"]
    type = "valve"
    manufacturer = "Swagelok"
    description = "1/2 in. ball valve, PTFE seat"

    ["swagelok-ss-8bk-v51".params.Cv]
    value = 1.2
    unit = "Cv"
    source = "manufacturer"
    reference = "SS-8BK-V51 datasheet rev C, table 2"

    ["swagelok-ss-8bk-v51".params.bore]
    value = 0.375
    unit = "in"
    source = "manufacturer"
    reference = "SS-8BK-V51 datasheet rev C"

    ["swagelok-ss-8bk-v51".measured.Cv]
    value = 1.14
    unit = "Cv"
    source = "measured"
    reference = "CF-2026-03, 12 points, R^2 0.998"

    ["tube-375-035"]
    type = "pipe"
    manufacturer = "generic"
    description = "3/8 in. x 0.035 wall stainless tube"

    ["tube-375-035".params.bore]
    value = 0.305
    unit = "in"
    source = "manufacturer"
    reference = "0.375 OD less 2 x 0.035 wall"

    ["tube-375-035".params.length]
    value = 1.0
    unit = "m"
    source = "estimated"
    reference = "placeholder; set per instance"
    """)


@pytest.fixture()
def catalog(tmp_path: Path) -> Catalog:
    path = tmp_path / "parts.toml"
    path.write_text(CATALOG_TOML)
    return Catalog.from_file(path)


def test_a_part_number_resolves_to_a_configured_component(catalog: Catalog) -> None:
    """Phase 02's exit criterion, stated directly."""
    valve = catalog.instantiate(
        "SOL-01", "swagelok-ss-8bk-v51", connections={"inlet": "n1", "outlet": "n2"}
    )

    assert valve.id == "SOL-01"
    assert valve.type == "valve"
    assert valve.part == "swagelok-ss-8bk-v51"
    assert valve.si("bore") == pytest.approx(0.009525)
    assert valve.connections == {"inlet": "n1", "outlet": "n2"}


def test_a_measurement_overrides_the_datasheet(catalog: Catalog) -> None:
    valve = catalog.instantiate("SOL-01", "swagelok-ss-8bk-v51")
    assert valve.si("Cv") == pytest.approx(1.14)
    assert valve.params["Cv"].source is Provenance.MEASURED
    assert "CF-2026-03" in valve.params["Cv"].reference


def test_the_datasheet_value_is_not_erased(catalog: Catalog) -> None:
    """Overwriting would destroy the only record that a discrepancy exists.

    A part measuring consistently below its rating is a finding -- mis-specified,
    installed wrong, or an optimistic datasheet -- and all three become invisible
    if the override replaces the original in place.
    """
    part = catalog.get("swagelok-ss-8bk-v51")
    assert part.params["Cv"].value == 1.2
    assert part.measured["Cv"].value == 1.14

    disagreements = part.disagreements(tolerance=0.01)
    assert "Cv" in disagreements
    claimed, found = disagreements["Cv"]
    assert claimed.si == pytest.approx(1.2)
    assert found.si == pytest.approx(1.14)


def test_agreement_within_tolerance_is_not_flagged(catalog: Catalog) -> None:
    part = catalog.get("swagelok-ss-8bk-v51")
    assert part.disagreements(tolerance=0.10) == {}


def test_per_instance_overrides_beat_the_catalog(catalog: Catalog) -> None:
    """One valve was trimmed; this run of tube is longer. No new part number."""
    line = catalog.instantiate(
        "FL-07",
        "tube-375-035",
        overrides={"length": Param(0.46, "m", Provenance.MEASURED, "tape, 2026-09-08")},
    )
    assert line.si("length") == pytest.approx(0.46)
    assert line.params["length"].source is Provenance.MEASURED
    # ...and everything not overridden still comes from the catalog.
    assert line.si("bore") == pytest.approx(0.007747)


def test_a_catalog_entry_missing_a_required_parameter_fails_at_load(
    tmp_path: Path,
) -> None:
    """With the parameter named, rather than as a missing key mid-solve."""
    path = tmp_path / "incomplete.toml"
    path.write_text(textwrap.dedent("""
            ["half-a-valve"]
            type = "valve"

            ["half-a-valve".params.Cv]
            value = 1.0
            unit = "Cv"
            source = "estimated"
            """))
    catalog = Catalog.from_file(path)
    with pytest.raises(ValueError, match="'bore' is required"):
        catalog.instantiate("SOL-01", "half-a-valve")


def test_an_unknown_part_lists_what_is_available(catalog: Catalog) -> None:
    with pytest.raises(CatalogError, match="Known parts include"):
        catalog.get("swagelok-ss-9zz-v99")


def test_a_part_must_declare_its_type(tmp_path: Path) -> None:
    path = tmp_path / "typeless.toml"
    path.write_text('["mystery"]\nmanufacturer = "unknown"\n')
    with pytest.raises(CatalogError, match="does not say what type it is"):
        Catalog.from_file(path)


def test_catalog_params_still_require_a_source(tmp_path: Path) -> None:
    """The rule holds inside a catalog file too, not only in code."""
    path = tmp_path / "sourceless.toml"
    path.write_text(textwrap.dedent("""
            ["a-part"]
            type = "pipe"

            ["a-part".params.bore]
            value = 0.01
            unit = "m"
            """))
    with pytest.raises(ValueError, match="missing required field"):
        Catalog.from_file(path)


def test_catalogs_layer(tmp_path: Path, catalog: Catalog) -> None:
    """A shipped catalog, a team catalog, a campaign catalog -- in that order."""
    override = tmp_path / "campaign.toml"
    override.write_text(textwrap.dedent("""
            ["swagelok-ss-8bk-v51"]
            type = "valve"
            manufacturer = "Swagelok"

            ["swagelok-ss-8bk-v51".params.Cv]
            value = 1.2
            unit = "Cv"
            source = "manufacturer"
            reference = "datasheet"

            ["swagelok-ss-8bk-v51".params.bore]
            value = 0.375
            unit = "in"
            source = "manufacturer"
            reference = "datasheet"

            ["swagelok-ss-8bk-v51".measured.Cv]
            value = 1.09
            unit = "Cv"
            source = "measured"
            reference = "CF-2026-11, after 40 cycles"
            """))
    catalog.load(override)
    assert catalog.instantiate("SOL-01", "swagelok-ss-8bk-v51").si(
        "Cv"
    ) == pytest.approx(1.09)


def test_parts_can_be_listed_and_filtered(catalog: Catalog) -> None:
    assert catalog.parts() == ["swagelok-ss-8bk-v51", "tube-375-035"]
    assert catalog.parts("pipe") == ["tube-375-035"]
    assert len(catalog) == 2
    assert "tube-375-035" in catalog


def test_a_catalog_round_trips_through_dicts(catalog: Catalog) -> None:
    data = catalog.to_dict()
    rebuilt = Catalog(Part.from_dict(pid, body) for pid, body in data.items())
    assert rebuilt.to_dict() == data


def test_measured_helper_tags_provenance() -> None:
    """What Phase 12 writes back when it fits a parameter to a flow test."""
    p = measured(1.14, "Cv", "CF-2026-03")
    assert p.source is Provenance.MEASURED
    assert p.reference == "CF-2026-03"
