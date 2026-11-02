"""An engine pulled from EngineDesign is the engine already here, when it is.

EngineDesign keeps a design as its validated config: ``PintleEngineConfig``
dumped, every default written out (35 keys the bundled YAML leaves to the
defaults). So the stand's engine pulled from EngineDesign is other bytes than
the bundled or uploaded copy, and was a second "Ethalox 7200N Doublet" --
freshness on one, the featured mark on the other -- although the cards built
from the two carry the same ``config_sha256`` (R008). EngineDesign is a stub
transport here that fingerprints a config as EngineDesign does: defaults
filled in.
"""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from typing import Any, Iterator

import httpx
import pytest
import yaml
from fastapi.testclient import TestClient

from backend import designtools, main
from backend.library import Library
from backend.overrides import OverrideStore

SAMPLE = Path(main.__file__).parent / "sample"
CONFIG = yaml.safe_load((SAMPLE / "ethalox-doublet.yaml").read_text("utf-8"))
CARD = json.loads((SAMPLE / "ethalox-doublet.card.json").read_text("utf-8"))

client = TestClient(main.app)


def _defaulted(config: dict[str, Any]) -> dict[str, Any]:
    """What EngineDesign stores for ``config``: three of the defaults its
    dump writes out (taken from a real one)."""
    out = copy.deepcopy(config)
    efficiency = out.setdefault("combustion", {}).setdefault("efficiency", {})
    efficiency.setdefault("mixing_distribution", "gaussian")
    fuel = out.setdefault("feed_system", {}).setdefault("fuel", {})
    fuel.setdefault("fittings", [])
    fuel.setdefault("derived_from", None)
    return out


def _fingerprint(config: dict[str, Any]) -> str:
    """EngineDesign's ``config_fingerprint``: the validated config's sha256.
    The sample's card carries the real one for the sample's config."""
    validated = _defaulted(config)
    if validated == _defaulted(CONFIG):
        return str(CARD["config_sha256"])
    return hashlib.sha256(json.dumps(validated, sort_keys=True).encode()).hexdigest()


@pytest.fixture
def lib(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Library]:
    """A fresh library holding the sample stand, as a first run's does."""
    fresh = Library(tmp_path / "library")
    monkeypatch.setattr(main, "library", fresh)
    monkeypatch.setattr(main, "overrides", OverrideStore(fresh.root / "o.json"))
    monkeypatch.setattr(main, "_UNBUILDABLE", {})
    main._seed_sample(revive=True)
    yield fresh


@pytest.fixture
def engine_design() -> Iterator[dict[str, Any]]:
    """EngineDesign holding the sample's engine as it stores it, and
    building a card for whatever it is sent."""
    current: dict[str, Any] = {"config": _defaulted(CONFIG), "ui": {}}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/layerx/engine-card":
            sent = yaml.safe_load(json.loads(request.read())["yaml"])
            return httpx.Response(
                200, json={**CARD, "config_sha256": _fingerprint(sent)}
            )
        if request.url.path.endswith("/load"):
            return httpx.Response(200, json=current)
        return httpx.Response(404)

    designtools.transport = httpx.MockTransport(handler)
    yield current
    designtools.transport = None


def _pull() -> dict[str, Any]:
    answer = client.post(
        "/api/sources/engine-design/import",
        json={
            "doc_id": "ethalox-7200n-doublet",
            "owner": "local",
            "name": "Ethalox 7200N Doublet",
        },
    )
    assert answer.status_code == 200, answer.text
    result: dict[str, Any] = answer.json()
    return result


def test_the_stands_engine_pulled_is_the_engine_already_here(
    lib: Library, engine_design: dict[str, Any]
) -> None:
    (sample,) = lib.list("engine")
    pulled = _pull()
    assert pulled["already_present"] is True
    assert pulled["artifact"]["id"] == sample.id
    assert len(lib.list("engine")) == 1, "one Ethalox 7200N Doublet, not two"
    row = next(
        r for r in client.get("/api/library?kind=engine").json() if r["id"] == sample.id
    )
    assert row["featured"] is True
    assert row["aliases"] == ["engine-design:local/ethalox-7200n-doublet@working copy"]

    # Freshness tracks the pull, and sees EngineDesign move on.
    fresh = client.get(f"/api/library/{sample.id}/freshness").json()
    assert fresh["tracked"] is True and fresh["current"] is True, fresh
    engine_design["config"]["combustion"]["efficiency"]["mixing_distribution"] = "flat"
    fresh = client.get(f"/api/library/{sample.id}/freshness").json()
    assert fresh["current"] is False, fresh


def test_another_engine_pulled_is_another_artifact(
    lib: Library, engine_design: dict[str, Any]
) -> None:
    """The other half: a config EngineDesign fingerprints differently is a
    new engine, with the card built for it."""
    engine_design["config"]["combustion"]["efficiency"]["mixing_distribution"] = "flat"
    (sample,) = lib.list("engine")
    pulled = _pull()
    assert pulled["already_present"] is False
    assert pulled["artifact"]["id"] != sample.id
    assert pulled["artifact"]["card"]["card_config_sha256"] == _fingerprint(
        engine_design["config"]
    )
    assert pulled["artifact"]["featured"] is False
