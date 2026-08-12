"""Shared fixtures: real Onshape responses, served without a network.

Regenerate the underlying JSON with `python tests/make_fixtures.py` after a
build. See that script for what each file is and why it is trimmed.

Onshape bills us per API call against a finite quota, so this suite must never
touch the network -- not in CI, not on a laptop that happens to have credentials
exported. `_no_network` below enforces that at the socket layer rather than
trusting every future test to remember.
"""

from __future__ import annotations

import json
import socket
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make any outbound connection raise, for every test in the suite.

    Blocking at `socket.socket.connect` catches httpx, urllib, and anything else
    a future test might reach for, and it fails loudly at the call site instead
    of quietly spending API credit. `make_fixtures.py` is a script, not a test,
    so it is unaffected.
    """

    def refuse(self: socket.socket, address: object) -> None:
        raise RuntimeError(
            f"network access is blocked in tests (tried to connect to {address!r}). "
            "Add a fixture under tests/fixtures/ instead -- Onshape API calls "
            "cost quota."
        )

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)


FIXTURES = Path(__file__).parent / "fixtures"

ROOT_DOCUMENT_ID = "dbf4d35d8e9fe37819466f72"
LINKED_DOCUMENT_ID = "f2d6380fa74c2e9a6866a59e"
MAIN_PART_STUDIO_ID = "ee2ef2459cdd449bba30c2f9"

# What the reference assembly actually contains, verified against Onshape.
EXPECTED_PARTS = 26
EXPECTED_OCCURRENCES = 28
EXPECTED_SUBASSEMBLIES = 2
EXPECTED_SOURCES = 5
EXPECTED_WITHOUT_MATERIAL = 14
ASSEMBLY_MASS = 2.7526301622113483
ASSEMBLY_CENTROID_Z = 0.5876840727414001


def load(name: str) -> object:
    return json.loads((FIXTURES / name).read_text())


@pytest.fixture
def assembly() -> dict:
    return load("assembly.json")


@pytest.fixture
def empty_version_assembly() -> dict:
    return load("assembly_empty_version.json")


@pytest.fixture
def assembly_massproperties() -> dict:
    return load("assembly_massproperties.json")


@pytest.fixture
def partstudio_massproperties() -> dict:
    return load("partstudio_massproperties.json")


@pytest.fixture
def parts_materials() -> list:
    return load("parts_materials.json")


@pytest.fixture
def tessellation() -> dict:
    return load("tessellation.json")


class FakeClient:
    """Stands in for OnshapeClient, dispatching on path shape.

    Deliberately not a mock: the tests care that the production code asks for the
    right paths and parameters, so unrecognised requests raise rather than
    returning a benign default.
    """

    def __init__(self, **overrides: object) -> None:
        self.requests: list[tuple[str, dict]] = []
        self._overrides = overrides

    @staticmethod
    def _element_of(path: str) -> str | None:
        """The 12-char element prefix the per-source fixtures are named by."""
        if "/e/" not in path:
            return None
        return path.split("/e/")[1].split("/")[0][:12]

    def _source_fixture(self, path: str, kind: str) -> object | None:
        element = self._element_of(path)
        if element is None:
            return None
        candidate = FIXTURES / f"source_{element}_{kind}.json"
        return load(candidate.name) if candidate.exists() else None

    def get_json(self, path: str, params: dict | None = None) -> object:
        self.requests.append((path, params or {}))

        for key, payload in self._overrides.items():
            if key in path:
                return payload

        # Per-source fixtures first: serving the main Part Studio's response for
        # every source would silently drop the 11 parts that live elsewhere.
        if "tessellatedfaces" in path:
            return self._source_fixture(path, "tess") or load("tessellation.json")
        if "bodydetails" in path:
            # No default fixture: an empty body list means "no surface types",
            # which the build tolerates (faces fall back to type OTHER).
            return self._source_fixture(path, "bodydetails") or {"bodies": []}
        if "massproperties" in path and path.startswith("/assemblies"):
            return load("assembly_massproperties.json")
        if "massproperties" in path:
            return self._source_fixture(path, "mass") or load("partstudio_massproperties.json")
        if path.startswith("/parts/"):
            return self._source_fixture(path, "parts") or load("parts_materials.json")
        if path.startswith("/assemblies/"):
            return load("assembly.json")
        if "versions" in path:
            return [{"id": "514cf9af0c739845880c4a5f", "name": "Start"}]
        if path.startswith("/documents/"):
            return {"name": "BART | Rocket"}

        raise AssertionError(f"FakeClient got an unexpected path: {path}")

    def map_parallel(self, fn, items):
        return [fn(item) for item in items]

    def stats(self) -> dict:
        return {"apiCalls": len(self.requests), "cacheHits": 0, "retries": 0}

    # Lets build() use it in place of OnshapeClient without special-casing.
    def __enter__(self) -> "FakeClient":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def close(self) -> None:
        return None


@pytest.fixture
def fake_client() -> FakeClient:
    return FakeClient()
