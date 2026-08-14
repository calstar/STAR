"""Mass properties parsing, material lookup, and the massAsGroup trap."""

from __future__ import annotations

import pytest

from backend.onshape.assembly import SourceKey
from backend.onshape.mass import (
    fetch_assembly_totals,
    fetch_source_bodies,
    fetch_source_materials,
    _scalar,
)
from conftest import (
    ASSEMBLY_CENTROID_Z,
    ASSEMBLY_MASS,
    MAIN_PART_STUDIO_ID,
    ROOT_DOCUMENT_ID,
    FakeClient,
)

SOURCE = SourceKey(
    document_id=ROOT_DOCUMENT_ID,
    microversion_id="53ff9eb118e83e8db40bcc4f",
    element_id=MAIN_PART_STUDIO_ID,
    configuration="default",
)


def test_scalar_reads_nominal_from_a_triple():
    """Every scalar in these responses is [nominal, lower, upper]."""
    assert _scalar([1.5, 1.4, 1.6]) == 1.5
    assert _scalar(2.0) == 2.0
    assert _scalar(None) == 0.0
    assert _scalar([]) == 0.0


def test_assembly_totals(fake_client: FakeClient):
    totals = fetch_assembly_totals(fake_client, "d/x/m/y/e/z")
    assert totals.mass == pytest.approx(ASSEMBLY_MASS)
    assert totals.centroid[2] == pytest.approx(ASSEMBLY_CENTROID_Z)


def test_centroid_is_truncated_to_three_coordinates(fake_client: FakeClient):
    """`centroid` is 9 numbers: 3 coordinates then 6 bound components.

    Reading past index 2 produces nonsense that still looks like a position.
    """
    totals = fetch_assembly_totals(fake_client, "d/x/m/y/e/z")
    assert len(totals.centroid) == 3


def test_mass_as_group_false_is_sent(fake_client: FakeClient):
    """Without it the response collapses to a single `-all-` aggregate, which
    silently gives every part the same mass."""
    fetch_source_bodies(fake_client, SOURCE)
    path, params = fake_client.requests[-1]
    assert "massproperties" in path
    assert params["massAsGroup"] == "false"


def test_per_part_bodies_are_returned(fake_client: FakeClient):
    bodies = fetch_source_bodies(fake_client, SOURCE)
    assert len(bodies) > 1
    assert "-all-" not in bodies, "the aggregate entry must be dropped"


def test_per_part_masses_sum_to_the_aggregate(partstudio_massproperties, fake_client: FakeClient):
    """The per-part breakdown must account for the whole Part Studio."""
    aggregate = partstudio_massproperties["bodies"].get("-all-")
    bodies = fetch_source_bodies(fake_client, SOURCE)
    total = sum(body.mass for body in bodies.values())

    if aggregate and aggregate.get("mass", [0])[0] > 0:
        assert total == pytest.approx(aggregate["mass"][0], rel=1e-9)
    else:
        # massAsGroup=false zeroes the aggregate; the sum is then the real total.
        assert total > 0


def test_materialless_parts_are_zeroed_not_omitted(fake_client: FakeClient):
    """Onshape returns hasMass=false with mass AND centroid zeroed.

    The zeroed centroid is the reason a default density alone is not enough:
    without a mesh-derived position the estimated mass lands at the origin.
    """
    bodies = fetch_source_bodies(fake_client, SOURCE)
    missing = [body for body in bodies.values() if not body.has_mass]
    assert missing, "the reference Part Studio has parts with no material"

    for body in missing:
        assert body.mass == 0.0
        assert body.centroid == [0.0, 0.0, 0.0]
        # Volume survives, which is what makes the estimate possible at all.
        assert body.volume > 0


def test_materials_parsed_from_dens_property(fake_client: FakeClient):
    materials = fetch_source_materials(fake_client, SOURCE)
    assert materials
    densities = {material.density for material in materials.values()}
    assert all(density > 0 for density in densities)
    # The reference model uses fiberglass and 6061.
    assert 1750.0 in densities


def test_parts_without_material_are_absent_from_the_map(fake_client: FakeClient):
    """A missing key means "unassigned", never "weightless"."""
    bodies = fetch_source_bodies(fake_client, SOURCE)
    materials = fetch_source_materials(fake_client, SOURCE)
    for part_id, body in bodies.items():
        if not body.has_mass:
            assert part_id not in materials


def test_link_document_id_forwarded_when_set(fake_client: FakeClient):
    fetch_source_bodies(fake_client, SOURCE, link_document_id="root-did")
    _, params = fake_client.requests[-1]
    assert params["linkDocumentId"] == "root-did"


def test_link_document_id_omitted_when_none(fake_client: FakeClient):
    fetch_source_bodies(fake_client, SOURCE, link_document_id=None)
    _, params = fake_client.requests[-1]
    assert "linkDocumentId" not in params or params["linkDocumentId"] is None
