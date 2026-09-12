"""The artifact library: content addressing, and what it prevents.

A run is only reproducible if it can say what it was run *on*. These tests pin
the properties that make that true.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.library import Library, LibraryError


@pytest.fixture()
def library(tmp_path: Path) -> Library:
    return Library(tmp_path / "lib")


def test_the_same_bytes_are_the_same_artifact(library: Library) -> None:
    """Saving from pid-designer twice in a session is normal, and must not
    leave two ids for one drawing."""
    data = b'{"nodes": [], "edges": []}'
    first, existed = library.add(
        data, kind="diagram", name="stand", source="upload", suffix=".json"
    )
    assert existed is False

    second, existed = library.add(
        data, kind="diagram", name="a different name", source="upload", suffix=".json"
    )
    assert existed is True
    assert second.id == first.id
    assert len(library.list()) == 1
    # The first name wins: the artifact is the bytes, not the filename.
    assert second.name == "stand"


def test_changed_bytes_are_a_different_artifact(library: Library) -> None:
    """So a result from last week still points at the thing that produced it."""
    a, _ = library.add(
        b'{"nodes": []}', kind="diagram", name="s", source="u", suffix=".json"
    )
    b, _ = library.add(
        b'{"nodes": [1]}', kind="diagram", name="s", source="u", suffix=".json"
    )
    assert a.id != b.id
    assert {x.id for x in library.list()} == {a.id, b.id}
    # And the old one is still readable, byte for byte.
    assert library.read(a.id) == b'{"nodes": []}'


def test_an_artifact_is_addressed_by_its_own_hash(library: Library) -> None:
    import hashlib

    data = b"engine: yes"
    artifact, _ = library.add(data, kind="engine", name="e", source="u", suffix=".yaml")
    assert artifact.sha256 == hashlib.sha256(data).hexdigest()
    assert artifact.sha256.startswith(artifact.id)


def test_listing_is_newest_first_and_filterable(library: Library) -> None:
    library.add(b"a", kind="diagram", name="d", source="u", suffix=".json")
    library.add(b"b", kind="engine", name="e", source="u", suffix=".yaml")
    assert [a.kind for a in library.list("diagram")] == ["diagram"]
    assert [a.kind for a in library.list("engine")] == ["engine"]
    assert len(library.list()) == 2


def test_an_unknown_id_says_what_is_there(library: Library) -> None:
    library.add(b"a", kind="diagram", name="d", source="u", suffix=".json")
    with pytest.raises(LibraryError, match="no artifact"):
        library.get("deadbeef")


def test_removal_takes_the_blob_with_it(library: Library) -> None:
    artifact, _ = library.add(
        b"a", kind="diagram", name="d", source="u", suffix=".json"
    )
    blob = library.path(artifact.id)
    assert blob.exists()
    library.remove(artifact.id)
    assert not blob.exists()
    assert library.list() == []


def test_the_manifest_survives_a_reopen(tmp_path: Path) -> None:
    """The store is a directory, so restarting the app must not lose it."""
    root = tmp_path / "lib"
    first = Library(root)
    artifact, _ = first.add(b"a", kind="diagram", name="d", source="u", suffix=".json")
    second = Library(root)
    assert [a.id for a in second.list()] == [artifact.id]
    assert second.read(artifact.id) == b"a"


def test_a_repeat_import_refreshes_the_summary(library: Library) -> None:
    """Content addressing promises the bytes; it promises nothing about a summary.

    A summary is derived by code, and code gets fixed. Keeping the first one
    meant an importer fix never reached a config already in the library -- it
    went on reporting the warnings it was imported with, and re-importing it,
    the obvious thing to try, was exactly the operation that did nothing.
    """
    data = b"thrust: 7000\n"
    first, existed = library.add(
        data,
        kind="engine",
        name="ethalox",
        source="upload",
        suffix=".yaml",
        summary={"mixture_ratio": 2.55, "warnings": ["design_MR disagrees"]},
    )
    assert existed is False

    second, existed = library.add(
        data,
        kind="engine",
        name="ethalox",
        source="upload",
        suffix=".yaml",
        summary={"mixture_ratio": 1.65, "warnings": []},
    )
    assert existed is True, "the same bytes are still the same artifact"
    assert second.id == first.id
    assert second.summary == {"mixture_ratio": 1.65, "warnings": []}
    assert (
        second.imported_at == first.imported_at
    ), "re-deriving a summary is not a new import"
    assert library.get(first.id).summary["mixture_ratio"] == 1.65, "and it persisted"


def test_a_repeat_import_with_no_summary_keeps_the_one_it_has(
    library: Library,
) -> None:
    """A caller that computes no summary must not blank the one already stored."""
    data = b"thrust: 7000\n"
    first, _ = library.add(
        data,
        kind="engine",
        name="ethalox",
        source="upload",
        suffix=".yaml",
        summary={"mixture_ratio": 1.65},
    )
    second, existed = library.add(
        data, kind="engine", name="ethalox", source="upload", suffix=".yaml"
    )
    assert existed is True
    assert second.summary == first.summary
