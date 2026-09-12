"""The app half of Phase 00's exit criterion.

``lib/feedtwin/tests`` proves the library imports in the library's environment.
This proves it imports in the *app's* -- which is a different environment, built
from a different requirements file, in a different container. Phase 00 claims
both, so both are checked.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)


def test_health() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}


def test_version_reports_the_physics_stack() -> None:
    """The API can reach feedtwin, and says which stack it reached.

    A version endpoint that returned only the app's own version would pass
    while the physics core was missing. Asserting on the dependencies is what
    makes this a real check of the wiring.
    """
    response = client.get("/api/version")
    assert response.status_code == 200

    stack = response.json()["stack"]
    assert stack["feedtwin"]

    missing = [
        name
        for name in ("numpy", "scipy", "CoolProp", "fluids", "ht")
        if stack.get(name) is None
    ]
    assert not missing, f"physics stack incomplete in the app environment: {missing}"
