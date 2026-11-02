"""The controller routes read only configs/ (and the caller's own uploads), and fail in a sentence.

``config_path`` and ``controller_config_path`` were opened as given: POST
/api/control/simulate-from-config {config_path: "<anywhere>/design.json"} opened a file outside the
app, any user could run another user's upload (output/user_configs/<them>/x.yaml) through the
controller past design sharing, and the 500 carried a full traceback with server paths.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytest.importorskip("fastapi", reason="API tests need fastapi")
pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient  # noqa: E402

import backend.main as backend_main  # noqa: E402
from backend.routers import control as control_router  # noqa: E402

H = {"X-Auth-Email": "control-paths@berkeley.edu"}


class _Opened(Exception):
    pass


@pytest.fixture
def opened(monkeypatch):
    """Record every path the route asks the loader to open; refuse to actually solve."""
    seen: list = []

    def load(path, *a, **k):
        seen.append(str(path))
        raise _Opened(f"opened {path}")

    monkeypatch.setattr(control_router, "load_engine_config", load)
    monkeypatch.setattr(control_router, "load_controller_config", load)
    return seen


@pytest.fixture
def client():
    return TestClient(backend_main.app, raise_server_exceptions=False)


@pytest.mark.parametrize("route", ["/api/control/simulate-from-config"])
def test_a_path_outside_configs_is_refused_unopened(client, opened, tmp_path, route):
    other = tmp_path / "otheruser" / "design.yaml"
    other.parent.mkdir()
    other.write_text("chamber: 1\n")
    for path in (str(other), "../output/user_configs/someone-else/design.yaml", "configs/../../../etc/passwd"):
        r = client.post(route, json={"config_path": path}, headers=H)
        assert r.status_code == 400, (path, r.status_code, r.text[:300])
    assert opened == [], f"the route opened {opened}"


def test_a_config_under_configs_is_read(client, opened):
    r = client.post("/api/control/simulate-from-config", json={"config_path": "configs/default.yaml"}, headers=H)
    assert opened and opened[0].endswith(os.path.join("configs", "default.yaml")), opened
    assert r.status_code == 500 and "Traceback" not in r.text and "File \\\"" not in r.text, r.text[:400]


def test_a_controller_config_outside_configs_is_refused(client, opened):
    r = client.post("/api/control/init", json={"controller_config_path": "../../etc/hosts.yaml"}, headers=H)
    assert r.status_code == 400, r.text[:300]
    assert opened == []


def test_the_stream_refuses_the_path_in_its_first_event(client, opened, tmp_path):
    r = client.post("/api/control/simulate-from-config-stream", json={"config_path": str(tmp_path / "x.yaml")}, headers=H)
    assert r.status_code == 200
    assert "must name a .yaml file under configs/" in r.text and opened == []


def test_a_failure_is_a_sentence_not_a_traceback(client, monkeypatch):
    import engine.core.runner as runner_mod

    def boom(*_a, **_k):
        raise RuntimeError("the solve fell over")

    monkeypatch.setattr(runner_mod, "PintleEngineRunner", boom)
    r = client.post("/api/control/simulate-from-config", json={}, headers=H)  # the session's own config
    assert r.status_code == 500
    assert "the solve fell over" in r.text and "Traceback" not in r.text, r.text[:400]
