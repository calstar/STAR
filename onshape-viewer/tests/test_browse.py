"""The picker's cache is what keeps browsing from spending Onshape API quota.

These tests are about that guarantee rather than about the store's mechanics:
that a cached read never reaches the network, that the index accumulates instead
of being replaced, and that a corrupt file degrades to "empty" rather than
taking the picker down.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.onshape.browse import BrowseCache


def make_document(document_id: str, name: str, **extra: object) -> dict:
    return {
        "documentId": document_id,
        "name": name,
        "workspaceId": f"w-{document_id}",
        "owner": extra.pop("owner", "Cal STAR"),
        "modifiedAt": extra.pop("modifiedAt", "2026-01-01T00:00:00Z"),
        **extra,
    }


@pytest.fixture
def cache(tmp_path: Path) -> BrowseCache:
    return BrowseCache(tmp_path / "browse.json")


def test_empty_cache_returns_nothing_rather_than_raising(cache: BrowseCache) -> None:
    # The file does not exist yet. The picker must still render.
    result = cache.search_documents("rocket")
    assert result == {"items": [], "fromCache": True, "cachedAt": None}


def test_store_then_search_is_served_locally(cache: BrowseCache) -> None:
    cache.store_documents([make_document("d1", "BART | Rocket")])

    result = cache.search_documents("rocket")

    assert result["fromCache"] is True
    assert [item["name"] for item in result["items"]] == ["BART | Rocket"]
    assert result["cachedAt"] is not None


def test_search_is_case_insensitive_and_matches_substrings(cache: BrowseCache) -> None:
    cache.store_documents([make_document("d1", "BART | Rocket")])

    assert cache.search_documents("ROCK")["items"]
    assert cache.search_documents("bart")["items"]
    assert cache.search_documents("nose")["items"] == []


def test_a_remembered_query_replays_onshapes_own_answer(cache: BrowseCache) -> None:
    """Onshape matches more than the name, so its answer has to be replayed.

    Searching "rocket" on this account returns documents with no "rocket" in
    their names -- it matches the owner and other fields. Re-filtering them by
    name locally meant a refresh showed six results and the very next keystroke
    showed none.
    """
    cache.store_documents([make_document("d1", "Solid Body")], query="rocket")

    assert [item["name"] for item in cache.search_documents("rocket")["items"]] == [
        "Solid Body"
    ]


def test_a_remembered_query_preserves_onshapes_rank_order(cache: BrowseCache) -> None:
    # Not modified-date order: the point of replaying is fidelity to Onshape.
    cache.store_documents(
        [
            make_document("a", "First", modifiedAt="2024-01-01T00:00:00Z"),
            make_document("b", "Second", modifiedAt="2026-01-01T00:00:00Z"),
        ],
        query="rocket",
    )

    assert [item["name"] for item in cache.search_documents("rocket")["items"]] == [
        "First",
        "Second",
    ]


def test_query_replay_ignores_whitespace_and_case(cache: BrowseCache) -> None:
    cache.store_documents([make_document("d1", "Solid Body")], query="Nose Cone")

    assert cache.search_documents("  nose   cone ")["items"]


def test_an_unremembered_query_falls_back_to_name_matching(cache: BrowseCache) -> None:
    cache.store_documents([make_document("d1", "BART | Rocket")], query="bart")

    # "rocket" was never refreshed, so this is the substring path.
    assert [item["name"] for item in cache.search_documents("rocket")["items"]] == [
        "BART | Rocket"
    ]


def test_search_ignores_owner(cache: BrowseCache) -> None:
    """Owner must not match, or one query returns the whole library.

    Nearly every document on this account is owned by "UC Berkeley Space
    Technologies and Rocketry". Matching owner meant a search for "rocket" --
    the single most likely thing to type here -- filtered nothing at all.
    """
    cache.store_documents(
        [make_document("d1", "Payload", owner="UC Berkeley ... and Rocketry")]
    )

    assert cache.search_documents("rocket")["items"] == []
    assert cache.search_documents("payload")["items"]


def test_empty_query_returns_everything(cache: BrowseCache) -> None:
    cache.store_documents(
        [make_document("d1", "Rocket"), make_document("d2", "Nose Cone")]
    )

    assert len(cache.search_documents("")["items"]) == 2


def test_refreshes_merge_rather_than_replace(cache: BrowseCache) -> None:
    """A search for 'rocket' must not evict what a search for 'nose' found.

    Onshape returns at most 20 documents per query, so replacing the index on
    every refresh would mean each new search term costs an API call and throws
    away the results of the last one -- exactly the behaviour this cache exists
    to stop.
    """
    cache.store_documents([make_document("d1", "BART | Rocket")])
    cache.store_documents([make_document("d2", "4in Nose Cone")])

    names = {item["name"] for item in cache.search_documents("")["items"]}
    assert names == {"BART | Rocket", "4in Nose Cone"}


def test_restoring_a_document_updates_it_in_place(cache: BrowseCache) -> None:
    cache.store_documents([make_document("d1", "Old Name")])
    cache.store_documents([make_document("d1", "New Name")])

    items = cache.search_documents("")["items"]
    assert len(items) == 1
    assert items[0]["name"] == "New Name"


def test_documents_sort_newest_modified_first(cache: BrowseCache) -> None:
    cache.store_documents(
        [
            make_document("old", "Old", modifiedAt="2024-01-01T00:00:00Z"),
            make_document("new", "New", modifiedAt="2026-06-01T00:00:00Z"),
        ]
    )

    assert [item["name"] for item in cache.search_documents("")["items"]] == [
        "New",
        "Old",
    ]


def test_documents_without_a_timestamp_do_not_break_sorting(cache: BrowseCache) -> None:
    cache.store_documents(
        [
            make_document("a", "Undated", modifiedAt=None),
            make_document("b", "Dated", modifiedAt="2026-06-01T00:00:00Z"),
        ]
    )

    assert [item["name"] for item in cache.search_documents("")["items"]] == [
        "Dated",
        "Undated",
    ]


def test_documents_with_no_id_are_skipped(cache: BrowseCache) -> None:
    cache.store_documents([{"name": "Nameless", "workspaceId": "w"}])

    assert cache.search_documents("")["items"] == []


def test_assemblies_are_missing_until_stored(cache: BrowseCache) -> None:
    # None, not an empty list: "never looked" has to be distinguishable from
    # "looked, and this document genuinely has no assembly tabs". The route
    # spends an API call on the first and not on the second.
    assert cache.get_assemblies("d1", "w1") is None


def test_stored_assemblies_come_back_marked_cached(cache: BrowseCache) -> None:
    cache.store_assemblies("d1", "w1", [{"elementId": "e1", "name": "Master Assembly"}])

    cached = cache.get_assemblies("d1", "w1")
    assert cached is not None
    assert cached["fromCache"] is True
    assert cached["items"] == [{"elementId": "e1", "name": "Master Assembly"}]
    assert cached["cachedAt"] is not None


def test_an_empty_assembly_list_is_still_a_cache_hit(cache: BrowseCache) -> None:
    cache.store_assemblies("d1", "w1", [])

    cached = cache.get_assemblies("d1", "w1")
    assert cached is not None
    assert cached["items"] == []


def test_assemblies_are_keyed_by_workspace_as_well_as_document(
    cache: BrowseCache,
) -> None:
    cache.store_assemblies("d1", "w1", [{"elementId": "e1", "name": "In w1"}])

    assert cache.get_assemblies("d1", "w2") is None


def test_a_corrupt_file_degrades_to_empty(cache: BrowseCache) -> None:
    cache.path.parent.mkdir(parents=True, exist_ok=True)
    cache.path.write_text("{ this is not json")

    assert cache.search_documents("")["items"] == []
    # And it recovers: the next store rewrites the file cleanly.
    cache.store_documents([make_document("d1", "Rocket")])
    assert cache.search_documents("")["items"]


def test_a_file_from_an_older_schema_is_discarded(cache: BrowseCache) -> None:
    cache.path.parent.mkdir(parents=True, exist_ok=True)
    cache.path.write_text(json.dumps({"version": 0, "documents": {"d1": {}}}))

    assert cache.search_documents("")["items"] == []


def test_a_missing_container_does_not_take_out_the_rest(cache: BrowseCache) -> None:
    cache.store_documents([make_document("d1", "Rocket")])
    data = json.loads(cache.path.read_text())
    del data["assemblies"]
    del data["queries"]
    cache.path.write_text(json.dumps(data))

    assert cache.search_documents("")["items"]
    assert cache.get_assemblies("d1", "w1") is None


# -- the routes, which are where the quota is actually spent -------------------


@pytest.fixture
def client(cache: BrowseCache, monkeypatch: pytest.MonkeyPatch):
    """A TestClient whose browse cache is a temp file and whose Onshape client
    detonates. Any route that reaches for Onshape without being asked to fails
    the test by name rather than by an obscure connection error.
    """
    from fastapi.testclient import TestClient

    from backend import main

    def forbidden(*args: object, **kwargs: object) -> None:
        raise AssertionError("route constructed an OnshapeClient without refresh=1")

    monkeypatch.setattr(main, "_browse", cache)
    monkeypatch.setattr(main, "OnshapeClient", forbidden)
    return TestClient(main.app)


def test_document_search_without_refresh_makes_no_api_call(client, cache) -> None:
    cache.store_documents([make_document("d1", "BART | Rocket")])

    response = client.get("/api/onshape/documents", params={"q": "rocket"})

    assert response.status_code == 200
    body = response.json()
    assert body["fromCache"] is True
    assert [item["name"] for item in body["items"]] == ["BART | Rocket"]


def test_empty_document_search_without_refresh_makes_no_api_call(client) -> None:
    # The picker opens with an empty query, which used to fire a request every
    # time the dropdown was clicked.
    response = client.get("/api/onshape/documents")

    assert response.status_code == 200
    assert response.json() == {"items": [], "fromCache": True, "cachedAt": None}


def test_cached_assemblies_make_no_api_call(client, cache) -> None:
    cache.store_assemblies("d1", "w1", [{"elementId": "e1", "name": "Master Assembly"}])

    response = client.get("/api/onshape/documents/d1/w/w1/assemblies")

    assert response.status_code == 200
    body = response.json()
    assert body["fromCache"] is True
    assert body["items"] == [{"elementId": "e1", "name": "Master Assembly"}]
