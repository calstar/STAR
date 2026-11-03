"""Layer 2/3 pressure curves as CSV, written by the backend (GET /api/optimizer/layer{2,3}/results.csv).

This file used to be built in the browser. The format has to stay what the browser
wrote, including JavaScript's way of printing numbers, so the expected strings
below are what Node's ``String(n)`` gives for each value (recorded from Node, not
from the code under test).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.results_csv import pressure_curves_csv  # noqa: E402
from stardesign.jsformat import js_number  # noqa: E402
from backend.session import UserSession, get_session  # noqa: E402

#: value -> String(value) in Node 20.
NODE = [
    (5, "5"), (5.0, "5"), (5.5, "5.5"), (0.1, "0.1"), (1e-7, "1e-7"), (1.5e-7, "1.5e-7"),
    (1e21, "1e+21"), (1.234e22, "1.234e+22"), (123456789012345680000, "123456789012345680000"),
    (2.5e-6, "0.0000025"), (101325.25, "101325.25"), (1e16, "10000000000000000"),
    (3.0000000000000004, "3.0000000000000004"), (-0.000001, "-0.000001"), (-42, "-42"),
    (1e-300, "1e-300"), (6894757.293168361, "6894757.293168361"), (0, "0"),
]


@pytest.mark.parametrize("value,expected", NODE)
def test_numbers_print_as_javascript_prints_them(value, expected):
    assert js_number(value) == expected


def test_csv_shape():
    out = pressure_curves_csv({"time_array": [0, 0.5], "lox_pressure": [3e6, 2.5e6], "fuel_pressure": [3.2e6, 2.75e6]})
    assert out == (
        "Time (s),LOX Pressure (Pa),Fuel Pressure (Pa)\n"
        "0,3000000,3200000\n"
        "0.5,2500000,2750000\n"
    )


def _client(session):
    from backend.routers import optimizer

    app = FastAPI()
    app.include_router(optimizer.router)
    app.dependency_overrides[get_session] = lambda: session
    return TestClient(app)


def test_endpoint_serves_each_layer_and_refuses_without_results():
    session = UserSession("results-csv")
    client = _client(session)
    assert client.get("/api/optimizer/layer2/results.csv").status_code == 404
    assert client.get("/api/optimizer/layer1/results.csv").status_code == 404

    session.optimizer.layer2_status["results"] = {"time_array": [0, 1], "lox_pressure": [1, 2], "fuel_pressure": [3, 4]}
    r = client.get("/api/optimizer/layer2/results.csv")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert 'filename="pressure_curves.csv"' in r.headers["content-disposition"]
    assert r.text.splitlines()[1:] == ["0,1,3", "1,2,4"]

    session.optimizer.layer3_status["results"] = {"time_array": [2], "lox_pressure": [5.5], "fuel_pressure": [6]}
    r = client.get("/api/optimizer/layer3/results.csv")
    assert r.status_code == 200 and 'filename="layer3_results.csv"' in r.headers["content-disposition"]
    assert r.text.splitlines()[1] == "2,5.5,6"
