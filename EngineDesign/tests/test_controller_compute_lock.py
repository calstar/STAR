"""One user's controller is touched by one request at a time: the streams and /reset too.

1298bf7a moved /init, /step, /simulate and /simulate-layer2 into ``run_compute`` (the thread pool,
under the session's compute lock) and the SSE streams' controller steps onto bare pool threads.
On the event loop the two kinds could only interleave between steps; on a bare thread a stream's
step ran beside a /simulate or /reset of the same ``session.controller`` from another tab, mid-step.
"""

from __future__ import annotations

import numpy as np
import pytest

pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient  # noqa: E402

import backend.main as backend_main  # noqa: E402
from backend import session as session_mod  # noqa: E402
from backend.routers import control as control_router  # noqa: E402

EMAIL = "controller-lock@berkeley.edu"
H = {"X-Auth-Email": EMAIL}


class _Stop(Exception):
    pass


def _lock_held() -> bool:
    return session_mod.registry.get(EMAIL).compute_lock.locked()


class FakeController:
    """Records whether the session's compute lock was held at each touch; never solves."""

    touches: list = []

    def __init__(self, cfg, engine_config, logger=None):
        self.cfg = cfg
        self.V_u_F = self.V_u_O = 0.01
        FakeController.touches.append(("build", _lock_held()))

    def reset(self):
        FakeController.touches.append(("reset", _lock_held()))

    def _build_state(self, meas):
        return np.zeros(8)

    def step(self, meas, nav, cmd):
        FakeController.touches.append(("step", _lock_held()))
        raise _Stop("recorded")


@pytest.fixture
def fake(monkeypatch):
    FakeController.touches = []
    monkeypatch.setattr(control_router, "RobustDDPController", FakeController)
    yield FakeController.touches
    session_mod.registry.get(EMAIL).controller.controller = None


def test_a_streams_controller_is_built_and_stepped_under_the_lock(fake):
    client = TestClient(backend_main.app)
    r = client.post("/api/control/simulate-layer2-stream", headers=H,
                    json={"thrust_curve_time": [0.0, 0.1], "thrust_curve_values": [6800.0, 6800.0]})
    assert r.status_code == 200
    assert "recorded" in r.text, r.text[:400]
    kinds = [k for k, _ in fake]
    assert kinds[:3] == ["build", "reset", "step"], fake
    assert all(held for _, held in fake), (
        f"the stream touched the controller without the session's compute lock: {fake}. A /simulate "
        "or /reset of the same controller could run beside it; go through run_compute."
    )


def test_reset_waits_for_the_lock(fake):
    client = TestClient(backend_main.app)
    client.get("/api/health", headers=H)
    session_mod.registry.get(EMAIL).controller.controller = FakeController(None, None)
    fake.clear()
    r = client.post("/api/control/reset", headers=H)
    assert r.status_code == 200, r.text[:300]
    assert fake == [("reset", True)], f"/reset touched the controller outside the compute lock: {fake}"
