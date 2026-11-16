"""URL parsing and workspace-to-immutable-ref resolution."""

from __future__ import annotations

import pytest

from backend.onshape.client import OnshapeError
from backend.onshape.urls import parse_document_url, resolve
from conftest import ROOT_DOCUMENT_ID, FakeClient

WORKSPACE_URL = (
    "https://starberkeley.onshape.com/documents/dbf4d35d8e9fe37819466f72"
    "/w/1df1c851058d46a5e5f08114/e/a194351ef67344579daff54b"
)


def test_parses_workspace_url():
    ref = parse_document_url(WORKSPACE_URL)
    assert ref.document_id == ROOT_DOCUMENT_ID
    assert ref.wvm == "w"
    assert ref.wvm_id == "1df1c851058d46a5e5f08114"
    assert ref.element_id == "a194351ef67344579daff54b"


def test_parses_enterprise_and_public_hosts():
    """Enterprise documents live on their own subdomain, not cad.onshape.com."""
    for host in ("https://cad.onshape.com", "https://starberkeley.onshape.com"):
        ref = parse_document_url(f"{host}/documents/{ROOT_DOCUMENT_ID}/v/" + "a" * 24 + "/e/" + "b" * 24)
        assert ref.document_id == ROOT_DOCUMENT_ID
        assert ref.wvm == "v"


def test_parses_url_with_trailing_query_and_fragment():
    ref = parse_document_url(WORKSPACE_URL + "?configuration=default#foo")
    assert ref.element_id == "a194351ef67344579daff54b"


@pytest.mark.parametrize(
    "bad",
    [
        "https://cad.onshape.com/documents/",
        "not a url at all",
        "https://cad.onshape.com/documents/tooshort/w/abc/e/def",
    ],
)
def test_rejects_unparseable_urls(bad):
    """Failing here beats failing several calls later with a confusing error."""
    with pytest.raises(OnshapeError):
        parse_document_url(bad)


def test_version_url_is_used_directly(fake_client: FakeClient):
    ref = parse_document_url(
        f"https://cad.onshape.com/documents/{ROOT_DOCUMENT_ID}/v/{'a' * 24}/e/{'b' * 24}"
    )
    resolved = resolve(fake_client, ref)
    assert resolved.wvm == "v"
    assert resolved.resolved_from == "version"
    assert fake_client.requests == [], "an immutable ref needs no lookup"


def test_microversion_url_is_used_directly(fake_client: FakeClient):
    ref = parse_document_url(
        f"https://cad.onshape.com/documents/{ROOT_DOCUMENT_ID}/m/{'a' * 24}/e/{'b' * 24}"
    )
    resolved = resolve(fake_client, ref)
    assert resolved.wvm == "m"
    assert resolved.resolved_from == "microversion"


def test_workspace_builds_the_current_microversion_not_the_last_version():
    """A /w/ link is the live model. It used to resolve to the newest named version,
    which built LE4 SD's week-old "V61" while the team had been editing all day."""
    client = FakeClient()
    resolved = resolve(client, parse_document_url(WORKSPACE_URL))
    assert resolved.wvm == "m"
    assert resolved.resolved_from == "workspace-microversion"
    assert resolved.microversion_id == FakeClient.current_microversion
    assert not any("versions" in path for path, _ in client.requests), "versions are not consulted"


def test_workspace_follows_edits_between_builds():
    """The current-microversion read bypasses the disk cache, so a second build after
    an edit pins the new state instead of replaying the first answer."""
    client = FakeClient()
    first = resolve(client, parse_document_url(WORKSPACE_URL))
    client.current_microversion = "f" * 24
    second = resolve(client, parse_document_url(WORKSPACE_URL))
    assert first.wvm_id != second.wvm_id == "f" * 24
    assert client.uncached == [
        "/documents/d/dbf4d35d8e9fe37819466f72/w/1df1c851058d46a5e5f08114/currentmicroversion"
    ] * 2


def test_uncached_read_never_touches_the_disk_cache(tmp_path, monkeypatch):
    from backend.onshape.client import OnshapeClient

    client = OnshapeClient(cache_dir=tmp_path)
    answers = iter([{"microversion": "a" * 24}, {"microversion": "b" * 24}])
    monkeypatch.setattr(client, "_get_with_retry", lambda path, params: next(answers))
    path = "/documents/d/x/w/y/currentmicroversion"
    assert client.get_json(path, cache=False)["microversion"] == "a" * 24
    assert client.get_json(path, cache=False)["microversion"] == "b" * 24
    assert list(tmp_path.iterdir()) == []


def test_uncached_read_refuses_offline(tmp_path):
    from backend.onshape.client import OnshapeClient

    client = OnshapeClient(cache_dir=tmp_path, offline=True)
    with pytest.raises(OnshapeError, match="asked live"):
        client.get_json("/documents/d/x/w/y/currentmicroversion", cache=False)


def test_element_path_includes_the_element(fake_client: FakeClient):
    """Assembly-scoped endpoints 404 without the /e/ segment."""
    ref = parse_document_url(
        f"https://cad.onshape.com/documents/{ROOT_DOCUMENT_ID}/v/{'a' * 24}/e/{'b' * 24}"
    )
    resolved = resolve(fake_client, ref)
    assert resolved.element_path.endswith("/e/" + "b" * 24)
    assert "/e/" not in resolved.path_prefix


def test_missing_element_id_is_rejected(fake_client: FakeClient):
    ref = parse_document_url(f"https://cad.onshape.com/documents/{ROOT_DOCUMENT_ID}/v/{'a' * 24}")
    with pytest.raises(OnshapeError, match="element id"):
        resolve(fake_client, ref)
