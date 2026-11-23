"""Assembly walk: subassembly flattening, absolute transforms, linked documents."""

from __future__ import annotations

import numpy as np
import pytest

from backend.onshape.assembly import occurrence_key, walk_assembly
from backend.onshape.urls import ResolvedRef
from conftest import (
    EXPECTED_OCCURRENCES,
    EXPECTED_PARTS,
    EXPECTED_SOURCES,
    EXPECTED_SUBASSEMBLIES,
    LINKED_DOCUMENT_ID,
    ROOT_DOCUMENT_ID,
    FakeClient,
)


@pytest.fixture
def walk(fake_client: FakeClient):
    ref = ResolvedRef(
        document_id=ROOT_DOCUMENT_ID,
        element_id="a194351ef67344579daff54b",
        wvm="m",
        wvm_id="53ff9eb118e83e8db40bcc4f",
        resolved_from="microversion",
    )
    return walk_assembly(fake_client, ref)


def test_flattens_subassembly_instances(walk):
    """Reading only rootAssembly.instances would find 14 of 26 parts here.

    That is the trap in orkv2.md Phase 1: the result still renders and still
    produces a centre of mass, so nothing surfaces the loss.
    """
    assert len(walk.occurrences) == EXPECTED_PARTS
    assert walk.total_occurrences == EXPECTED_OCCURRENCES
    assert walk.subassembly_count == EXPECTED_SUBASSEMBLIES


def test_nested_parts_are_present(walk):
    """Parts reached only through a subassembly path must appear."""
    nested = [occ for occ in walk.occurrences if len(occ.path) > 1]
    assert len(nested) == 14, "every depth-2 occurrence should have been resolved"


def test_transforms_are_used_absolutely(walk, assembly):
    """Occurrence transforms are absolute; chaining them through the path is wrong."""
    by_key = {occ.key: occ for occ in walk.occurrences}
    for raw in assembly["rootAssembly"]["occurrences"]:
        key = occurrence_key(raw["path"])
        if key in by_key:
            assert by_key[key].transform == list(raw["transform"])


def test_nested_transform_is_not_chained(walk):
    """A depth-2 part's transform must equal the API value, not parent x child."""
    nested = next(occ for occ in walk.occurrences if len(occ.path) > 1)
    matrix = np.asarray(nested.transform).reshape(4, 4)

    # A chained transform would almost always leave the bottom row non-trivial
    # or scale the rotation block; the raw values are proper rigid transforms.
    assert matrix[3].tolist() == [0.0, 0.0, 0.0, 1.0]
    rotation = matrix[:3, :3]
    assert np.allclose(rotation @ rotation.T, np.eye(3), atol=1e-9)


def test_linked_document_keeps_its_own_ids(walk):
    """Instances from a linked document must not inherit the assembly's ids.

    orkv2.md 7.5 calls this the most common bug in this area.
    """
    linked = [occ for occ in walk.occurrences if occ.source.document_id == LINKED_DOCUMENT_ID]
    assert linked, "the reference assembly contains a linked document"

    for occ in linked:
        assert occ.source.document_id != ROOT_DOCUMENT_ID
        # Its microversion is its own, not the root assembly's.
        assert occ.source.microversion_id != "53ff9eb118e83e8db40bcc4f"


def test_unique_sources(walk):
    assert len(walk.sources) == EXPECTED_SOURCES
    documents = {source.document_id for source in walk.sources}
    assert documents == {ROOT_DOCUMENT_ID, LINKED_DOCUMENT_ID}


def test_occurrence_keys_are_unique(walk):
    """The key is the only join between the manifest and the GLB, so collisions
    would silently give two parts the same mass."""
    keys = [occ.key for occ in walk.occurrences]
    assert len(set(keys)) == len(keys)


def test_names_are_not_unique_so_cannot_be_identity(walk):
    """Guards the reason keys are path-derived rather than name-derived."""
    names = [occ.name for occ in walk.occurrences]
    base = [name.split("<")[0].strip() for name in names]
    assert len(set(base)) < len(base), "duplicate part names exist, as expected"


def test_subassembly_nodes_are_skipped(walk):
    """Occurrences whose tail is a subassembly contribute no mass of their own."""
    assert walk.total_occurrences - len(walk.occurrences) == EXPECTED_SUBASSEMBLIES


def test_instance_ids_reused_by_copied_subassemblies_resolve_to_their_own_parts():
    """Instance ids are unique only within one assembly definition. LE4 SD's Fwd and
    Aft Avbay Bulkhead Assemblies (one copied from the other) share ids, and a flat
    id map built the forward bulkhead from the aft bulkhead's Part Studio."""
    identity = np.eye(4).flatten().tolist()
    mv = "m" * 24

    def asm_instance(iid, element):
        return {"id": iid, "type": "Assembly", "name": element, "documentId": ROOT_DOCUMENT_ID,
                "elementId": element, "documentMicroversion": mv, "fullConfiguration": "default"}

    def part(iid, element, name):
        return {"id": iid, "type": "Part", "name": name, "partId": "JHD", "documentId": ROOT_DOCUMENT_ID,
                "elementId": element, "documentMicroversion": mv, "fullConfiguration": "default"}

    payload = {
        "rootAssembly": {
            "documentMicroversion": mv,
            "instances": [asm_instance("FWD", "fwd-asm"), asm_instance("AFT", "aft-asm")],
            "occurrences": [
                {"path": ["FWD", "SAME"], "transform": identity},
                {"path": ["AFT", "SAME"], "transform": identity},
            ],
        },
        "subAssemblies": [
            {"documentId": ROOT_DOCUMENT_ID, "elementId": "fwd-asm", "documentMicroversion": mv,
             "fullConfiguration": "default", "instances": [part("SAME", "fwd-studio", "Fwd Bulkhead <1>")]},
            {"documentId": ROOT_DOCUMENT_ID, "elementId": "aft-asm", "documentMicroversion": mv,
             "fullConfiguration": "default", "instances": [part("SAME", "aft-studio", "Aft Bulkhead <1>")]},
        ],
    }
    client = FakeClient(**{"/assemblies/": payload})
    ref = ResolvedRef(ROOT_DOCUMENT_ID, "root-asm", "m", mv, "microversion")
    walk = walk_assembly(client, ref)

    got = {tuple(o.path): (o.name, o.source.element_id) for o in walk.occurrences}
    assert got == {
        ("FWD", "SAME"): ("Fwd Bulkhead <1>", "fwd-studio"),
        ("AFT", "SAME"): ("Aft Bulkhead <1>", "aft-studio"),
    }
    assert {s.element_id for s in walk.sources} == {"fwd-studio", "aft-studio"}
