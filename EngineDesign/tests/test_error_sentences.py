"""Every error response is {"detail": "<one plain sentence>"} (docs/investor contract C3).

FastAPI's own request-validation failures used to send `detail` as a list of {loc, msg, type}
objects, which a page rendered as "[object Object]".
"""

from fastapi.testclient import TestClient

from backend.main import app, validation_sentence


def test_validation_list_becomes_one_sentence():
    errs = [{"loc": ("body", "lox_pressure_psi"), "msg": "Input should be a valid number", "type": "x"},
            {"loc": ("body", "fuel_pressure_psi"), "msg": "Field required", "type": "y"}]
    # Every problem, by its field -- not the first and a count (a rail with two bad fields used
    # to say only the first).
    assert validation_sentence(errs) == (
        "Lox pressure psi: Input should be a valid number; fuel pressure psi: Field required."
    )
    assert validation_sentence([]) == "Some of the values were not accepted."


def test_a_malformed_request_answers_with_a_sentence():
    client = TestClient(app)
    r = client.post("/api/evaluate", json={"lox_pressure_psi": "not a number"})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert isinstance(detail, str) and detail.endswith(".")


def test_the_field_paths_ride_along_for_pages_with_their_own_names():
    client = TestClient(app)
    r = client.post("/api/evaluate", json={"lox_pressure_psi": "not a number"})
    errors = r.json()["errors"]
    assert errors and all(isinstance(e["loc"], list) and "msg" in e for e in errors)
