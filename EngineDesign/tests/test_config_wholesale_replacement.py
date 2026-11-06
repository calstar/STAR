"""Every route that swaps the session config wholesale does it the way /api/config/upload does.

That is: nothing changes on a refusal, the design checkout is asked, set_config runs off the event
loop, and the session's ``load_token`` is new and handed back. The token is how a second tab of
the same user (one session per user, shared by every tab) notices the design it loaded is gone and
stops autosaving; a swap that kept the old token let that tab write the newcomer over its design.

Found on the LE4 (3) stand's engine YAML (no ``pressure_curves``): POST /api/timeseries/from-csv
answered 400 "does not contain a 'pressure_curves' section" *after* replacing the config, the UI
kept showing the old design, and the design bar autosaved the "failed" upload into it. The Layer 2
and Layer 3 upload-config routes swapped the config with no token and no checkout.
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import threading

import pytest
import yaml

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytest.importorskip("fastapi", reason="API tests need fastapi")
pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient  # noqa: E402
from starlette.datastructures import Headers, UploadFile  # noqa: E402
from starlette.requests import Request  # noqa: E402

import backend.main as backend_main  # noqa: E402
from backend import session as session_mod  # noqa: E402
from backend import state as state_mod  # noqa: E402
from backend.routers import timeseries as timeseries_router  # noqa: E402

DEFAULT = yaml.safe_load(session_mod._DEFAULT_CONFIG_PATH.read_text())


def _without_curves() -> bytes:
    data = dict(DEFAULT)
    data["pressure_curves"] = None
    # A different design from the default, so a swap is visible in GET /api/config.
    data["chamber_geometry"] = {**data["chamber_geometry"], "design_thrust": 6500.0}
    return yaml.safe_dump(data).encode()


def _with_curves() -> bytes:
    data = dict(DEFAULT)
    data["chamber_geometry"] = {**data["chamber_geometry"], "design_thrust": 6400.0}
    return yaml.safe_dump(data).encode()


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    monkeypatch.setattr(backend_main, "project_root", tmp_path)


@pytest.fixture
def client():
    return TestClient(backend_main.app, raise_server_exceptions=False)


def _state(client, headers):
    body = client.get("/api/config", headers=headers).json()
    return body["config"]["chamber_geometry"]["design_thrust"], body.get("load_token")


def test_a_yaml_without_curves_is_refused_and_changes_nothing(client):
    h = {"X-Auth-Email": "wholesale-nocurves@berkeley.edu"}
    before = _state(client, h)
    r = client.post(
        "/api/timeseries/from-csv",
        files={"file": ("engine.yaml", _without_curves(), "application/x-yaml")},
        headers=h,
    )
    assert r.status_code == 400, r.text[:300]
    assert "pressure_curves" in r.json()["detail"]
    assert _state(client, h) == before, (
        "a from-csv request answered 400 had already replaced the session config"
    )


def test_a_yaml_from_csv_needs_the_checkout_and_changes_nothing_without_it(client, monkeypatch):
    h = {"X-Auth-Email": "wholesale-checkout@berkeley.edu"}
    r = client.post(
        "/api/engine/documents", headers=h, json={"name": "Held", "config": {"combustion": {}}}
    )
    doc_id = r.json()["id"]
    assert client.delete(f"/api/engine/documents/{doc_id}/checkout", headers=h).status_code == 200
    ran: list = []
    monkeypatch.setattr(timeseries_router, "compute_timeseries_results", lambda *a, **k: ran.append(1))
    before = _state(client, h)
    r = client.post(
        "/api/timeseries/from-csv",
        files={"file": ("engine.yaml", _with_curves(), "application/x-yaml")},
        headers={**h, "X-Design-Id": doc_id},
    )
    assert r.status_code == 423, r.text[:300]
    assert _state(client, h) == before and not ran


def test_a_yaml_from_csv_that_replaces_the_config_returns_a_new_token(client, monkeypatch):
    h = {"X-Auth-Email": "wholesale-curves@berkeley.edu"}
    monkeypatch.setattr(
        timeseries_router, "compute_timeseries_results", lambda *a, **k: ({"time": [0.0]}, {})
    )
    _, token_before = _state(client, h)
    r = client.post(
        "/api/timeseries/from-csv",
        files={"file": ("engine.yaml", _with_curves(), "application/x-yaml")},
        headers=h,
    )
    assert r.status_code == 200, r.text[:300]
    thrust, token = _state(client, h)
    assert thrust == 6400.0
    assert token and token != token_before, "from-csv replaced the config without a new load_token"
    assert r.json()["load_token"] == token


@pytest.mark.parametrize("layer", ["layer2", "layer3"])
def test_layer_upload_config_rotates_and_returns_the_token(client, layer):
    h = {"X-Auth-Email": f"wholesale-{layer}@berkeley.edu"}
    _, token_before = _state(client, h)
    r = client.post(
        f"/api/optimizer/{layer}/upload-config",
        files={"file": ("engine.yaml", _with_curves(), "application/x-yaml")},
        headers=h,
    )
    assert r.status_code == 200, r.text[:300]
    thrust, token = _state(client, h)
    assert thrust == 6400.0
    assert token and token != token_before, f"{layer} upload-config replaced the config, same token"
    assert r.json().get("load_token") == token


@pytest.mark.parametrize("layer", ["layer2", "layer3"])
def test_layer_upload_config_needs_the_checkout(client, layer):
    h = {"X-Auth-Email": f"wholesale-{layer}-checkout@berkeley.edu"}
    r = client.post(
        "/api/engine/documents", headers=h, json={"name": "Held", "config": {"combustion": {}}}
    )
    doc_id = r.json()["id"]
    assert client.delete(f"/api/engine/documents/{doc_id}/checkout", headers=h).status_code == 200
    before = _state(client, h)
    r = client.post(
        f"/api/optimizer/{layer}/upload-config",
        files={"file": ("engine.yaml", _with_curves(), "application/x-yaml")},
        headers={**h, "X-Design-Id": doc_id},
    )
    assert r.status_code == 423, r.text[:300]
    assert _state(client, h) == before


# --- Off the event loop -------------------------------------------------------------------------


def _request(email: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/",
            "query_string": b"",
            "headers": [(b"x-auth-email", email.encode())],
        }
    )


def _upload(name: str, body: bytes) -> UploadFile:
    return UploadFile(file=io.BytesIO(body), filename=name, headers=Headers({}))


def test_from_csv_runs_its_solve_and_its_swap_off_the_event_loop(monkeypatch):
    seen: dict[str, int] = {}
    real_set_config = state_mod.AppState.set_config

    def spy_set_config(self, *a, **k):
        seen["set_config"] = threading.get_ident()
        return real_set_config(self, *a, **k)

    def spy_compute(*_a, **_k):
        seen.setdefault("compute", threading.get_ident())
        return {"time": [0.0]}, {}

    monkeypatch.setattr(state_mod.AppState, "set_config", spy_set_config)
    monkeypatch.setattr(timeseries_router, "compute_timeseries_results", spy_compute)

    async def main():
        seen["loop"] = threading.get_ident()
        req = _request("wholesale-offload@berkeley.edu")
        session = session_mod.get_session(req)
        csv = b"time,P_O,P_F\n0,500,450\n1,480,430\n"
        await timeseries_router.generate_from_csv(req, file=_upload("p.csv", csv), session=session)
        assert seen.pop("compute") != seen["loop"], "the CSV run went on the event-loop thread"
        await timeseries_router.generate_from_csv(
            req, file=_upload("engine.yaml", _with_curves()), session=session
        )

    asyncio.run(main())
    assert seen["set_config"] != seen["loop"], "from-csv's YAML swap ran set_config on the loop"
    assert seen["compute"] != seen["loop"], "from-csv's YAML run went on the event-loop thread"


def test_upload_config_and_simulate_never_swaps_the_session_config(client, monkeypatch):
    """A controller run on an uploaded file is a simulation, not a load.

    It used to set_config the uploaded engine for the length of the run (inline on the event loop)
    and put the old one back after. Nothing in the run read it, but GET /api/config did: the design
    bar's tick saw its own load token and autosaved the uploaded engine into the open design.
    """
    import engine.core.runner as runner_mod
    from backend.routers import control as control_router

    class FakeRunner:
        def __init__(self, config):
            pass

        def evaluate(self, **_kwargs):
            return {"F": 6800.0}

    def no_controller(*_a, **_k):
        raise RuntimeError("controller not under test")

    swaps: list = []
    real_set_config = state_mod.AppState.set_config

    def spy(self, *a, **k):
        swaps.append(a[0] if a else k.get("config"))
        return real_set_config(self, *a, **k)

    monkeypatch.setattr(runner_mod, "PintleEngineRunner", FakeRunner)
    monkeypatch.setattr(control_router, "RobustDDPController", no_controller)
    h = {"X-Auth-Email": "wholesale-ctrl-upload@berkeley.edu"}
    before = _state(client, h)
    session_mod.registry.get("wholesale-ctrl-upload@berkeley.edu").controller.controller = None
    monkeypatch.setattr(state_mod.AppState, "set_config", spy)
    r = client.post(
        "/api/control/upload-config-and-simulate",
        files={"file": ("engine.yaml", _with_curves(), "application/x-yaml")},
        headers=h,
    )
    assert r.status_code == 200
    assert "controller not under test" in r.text, "the run did not get as far as the controller"
    assert swaps == [], f"the run put {len(swaps)} config(s) into the session"
    assert _state(client, h) == before
