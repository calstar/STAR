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


def test_workspace_falls_back_when_every_version_is_empty(empty_version_assembly):
    """The reference document's only version was cut before any modelling.

    Selecting it would build a valid, empty, useless model, so the resolver must
    pin the workspace's current microversion instead.
    """
    client = FakeClient()
    original = client.get_json

    def get_json(path, params=None):
        # Version reads return the empty assembly; workspace reads return the real one.
        if path.startswith("/assemblies/") and "/v/" in path:
            client.requests.append((path, params or {}))
            return empty_version_assembly
        return original(path, params)

    client.get_json = get_json  # type: ignore[method-assign]

    resolved = resolve(client, parse_document_url(WORKSPACE_URL))

    assert resolved.wvm == "m"
    assert resolved.resolved_from == "workspace-microversion"
    assert resolved.microversion_id == "53ff9eb118e83e8db40bcc4f"
    assert any("no geometry" in warning for warning in resolved.warnings)
    assert any("cut a version" in warning for warning in resolved.warnings)


def test_workspace_prefers_a_populated_version():
    """When a version does have geometry, it wins -- it is the more meaningful key."""
    client = FakeClient()
    resolved = resolve(client, parse_document_url(WORKSPACE_URL))
    assert resolved.wvm == "v"
    assert resolved.resolved_from == "version"
    assert resolved.version_id == "514cf9af0c739845880c4a5f"


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
