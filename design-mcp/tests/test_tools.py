"""The tools, end to end through /mcp against fake apps."""

from __future__ import annotations

import asyncio
import json

import httpx

from .conftest import ALICE, BOB

LAYERX_CSV = "t [s],chamber.pc [psia],thrust [N]\n" + "".join(
    f"{i * 0.01:.2f},{300 + (2000 if i == 357 else 0)},{1000 + i}\n" for i in range(1000)
)


def _layerx(harness):
    harness.fake.on(
        "engine-design", "GET", "/api/layerx/runs/run1/export/csv", lambda req: httpx.Response(200, text=LAYERX_CSV)
    )


async def test_tool_list_is_read_only(harness):
    r = await harness.rpc("tools/list")
    tools = r.json()["result"]["tools"]
    names = {t["name"] for t in tools}
    assert {"list_designs", "get_design", "layerx_run_table", "table_plot", "daq_series", "job_status"} <= names
    for t in tools:
        assert t.get("annotations", {}).get("readOnlyHint") is True, t["name"]


async def test_layerx_run_becomes_a_table_with_units_and_peaks(harness):
    _layerx(harness)
    table = await harness.call_json("layerx_run_table", {"run_id": "run1"})
    assert table["rows"] == 1000
    sigs = {s[0]: s for s in table["signals"]}
    assert sigs["chamber.pc"][1] == "psia"
    assert sigs["chamber.pc"][3] == 2300.0  # max survives into the table description

    series = await harness.call_json(
        "table_series", {"table_id": table["table_id"], "signals": ["chamber.pc"], "max_points": 50}
    )
    pc = series["series"][0]
    assert len(pc["y"]) <= 50
    assert max(pc["y"]) == 2300.0, "downsampling kept the spike"
    assert pc["max"] == 2300.0


async def test_a_table_is_its_owners_only(harness):
    _layerx(harness)
    table = await harness.call_json("layerx_run_table", {"run_id": "run1"}, token=ALICE)
    other = await harness.call("table_series", {"table_id": table["table_id"], "signals": ["thrust"]}, token=BOB)
    assert other["isError"]
    assert "No table" in other["content"][0]["text"]


async def test_table_plot_returns_a_png(harness):
    _layerx(harness)
    table = await harness.call_json("layerx_run_table", {"run_id": "run1"})
    result = await harness.call("table_plot", {"table_id": table["table_id"], "signals": ["chamber.pc", "thrust"]})
    assert not result["isError"]
    img = next(c for c in result["content"] if c["type"] == "image")
    assert img["mimeType"] == "image/png"
    import base64

    assert base64.b64decode(img["data"])[:4] == b"\x89PNG"


async def test_exports_are_links_that_download_with_range(harness):
    body = b"x" * 5000
    harness.fake.on(
        "engine-design",
        "GET",
        "/api/layerx/runs/run1/export/fea",
        lambda req: httpx.Response(
            200, content=body, headers={"content-disposition": 'attachment; filename="layerx-run1-fea.zip"'}
        ),
    )
    link = await harness.call_json("layerx_export", {"run_id": "run1", "fmt": "fea"})
    assert link["filename"] == "layerx-run1-fea.zip"
    assert link["size"] == 5000
    path = "/" + link["url"].split("/", 3)[3]
    full = await harness.client.get(path)
    assert full.status_code == 200 and full.content == body
    part = await harness.client.get(path, headers={"Range": "bytes=100-199"})
    assert part.status_code == 206 and len(part.content) == 100


async def test_a_slow_export_hands_back_a_job_then_finishes(harness, monkeypatch):
    gate = asyncio.Event()

    async def slow_post(app, path, body, **kw):
        await gate.wait()
        return {"run_id": "r9", "components": [{"name": "pt1", "primary": True}], "n_components": 1}

    harness.app.state.ctx.jobs._inline_wait_s = 0.05
    monkeypatch.setattr(harness.app.state.ctx.apps, "post_json", slow_post)
    started = await harness.call_json("daq_index_run", {"run_id": "r9"})
    assert started["status"] in ("queued", "running")
    other = await harness.call("job_status", {"job_id": started["job_id"], "wait_s": 0}, token=BOB)
    assert other["isError"], "someone else's job is not visible"
    gate.set()
    done = await harness.call_json("job_status", {"job_id": started["job_id"], "wait_s": 5})
    assert done["status"] == "done"
    assert done["result"]["n_components"] == 1


async def test_small_design_inline_large_design_as_link(harness):
    small = {"nodes": [{"id": "a"}], "edges": []}
    big = {"nodes": [{"id": f"n{i}", "label": "x" * 100} for i in range(2000)], "edges": []}
    harness.fake.on("pid-designer", "GET", "/api/pid/diagrams/d1/load", lambda req: httpx.Response(200, json=small))
    harness.fake.on("pid-designer", "GET", "/api/pid/diagrams/d2/load", lambda req: httpx.Response(200, json=big))
    a = await harness.call_json("get_design", {"app": "pid-designer", "design_id": "d1"})
    assert a["design"] == small
    b = await harness.call_json("get_design", {"app": "pid-designer", "design_id": "d2", "owner": "bob"})
    assert "design" not in b
    assert b["shape"]["nodes"] == "list of 2000"
    assert b["file"]["url"].startswith("http://127.0.0.1:8010/files/")
    assert harness.fake.seen[-1].url.params["owner"] == "bob"


async def test_an_app_error_reaches_the_agent_as_a_tool_error(harness):
    harness.fake.on(
        "engine-design",
        "GET",
        "/api/layerx/runs/nope",
        lambda req: httpx.Response(404, json={"detail": "No run 'nope'."}),
    )
    result = await harness.call("layerx_get_run", {"run_id": "nope"})
    assert result["isError"]
    assert "No run 'nope'." in result["content"][0]["text"]


async def test_layerx_run_omits_series(harness):
    run = {
        "id": "r",
        "status": "done",
        "result": {"summary": {"total_impulse_Ns": 1}, "series": {"t": list(range(5000))}},
    }
    harness.fake.on("engine-design", "GET", "/api/layerx/runs/r", lambda req: httpx.Response(200, json=run))
    out = await harness.call_json("layerx_get_run", {"run_id": "r"})
    assert "5000 steps" in out["result"]["series"]["_omitted"]
    assert len(json.dumps(out)) < 2000


async def test_layerx_run_outline_names_big_sections_and_fetches_one(harness):
    stability = {"margin": [0.5] * 30, "note": "x" * 3000}
    big = {"rows": [{"k": i, "v": "y" * 200} for i in range(400)]}
    run = {
        "id": "r",
        "status": "done",
        "settings": {"drawing_id": "d"},
        "result": {
            "summary": {"total_impulse_Ns": 23055.3},
            "diagnostics": {"stability": stability, "ledger": big},
            "series": {"t": [0, 1]},
        },
    }
    harness.fake.on("engine-design", "GET", "/api/layerx/runs/r", lambda req: httpx.Response(200, json=run))
    out = await harness.call_json("layerx_get_run", {"run_id": "r"})
    assert out["result"]["summary"] == {"total_impulse_Ns": 23055.3}, "a small section is inline"
    assert "diagnostics" not in out["result"]
    assert out["sections"]["diagnostics"]["parts"] == ["ledger", "stability"]
    assert len(json.dumps(out)) < 4000
    full = await harness.client.get("/" + out["full_run"]["url"].split("/", 3)[3])
    assert full.json() == run, "the link is the whole run, series and all"

    one = await harness.call_json("layerx_get_run", {"run_id": "r", "section": "diagnostics.stability"})
    assert one["value"] == stability

    whole = await harness.call_json("layerx_get_run", {"run_id": "r", "section": "diagnostics"})
    assert set(whole["parts"]) == {"stability", "ledger"}, "too big inline: a link and its parts"
    linked = await harness.client.get("/" + whole["link"]["url"].split("/", 3)[3])
    assert linked.json() == run["result"]["diagnostics"]

    bad = await harness.call("layerx_get_run", {"run_id": "r", "section": "diagnostics.stabilty"})
    assert bad["isError"] and "diagnostics has ledger, stability" in bad["content"][0]["text"]


async def test_daq_components_group_by_sensor_unless_narrowed(harness):
    comps = [
        {"name": f"PT{i}.CH1.{f}", "entity": f"PT{i}.CH1", "field": f, "family": "PT", "unit": u, "label": f"Tank {i}"}
        for i in range(40)
        for f, u in (("pressure_psi", "psi"), ("raw_adc_counts", ""))
    ]
    comps.append(
        {"name": "ACT2.CH1.state", "entity": "ACT2.CH1", "field": "state", "family": "ACT", "label": "Fuel Upstream"}
    )
    index = {"run_id": "r9", "n_components": len(comps), "components": comps}
    harness.fake.on("daq-viewer", "GET", "/api/runs/r9/components", lambda req: httpx.Response(200, json=index))

    out = await harness.call_json("daq_components", {"run_id": "r9"})
    assert out["matched"] == 81 and "components" not in out
    sensors = {s["entity"]: s for s in out["sensors"]}
    assert sensors["PT7.CH1"]["fields"] == {"pressure_psi": "psi", "raw_adc_counts": ""}
    assert sensors["PT7.CH1"]["label"] == "Tank 7"

    one = await harness.call_json("daq_components", {"run_id": "r9", "match": "fuel upstream"})
    assert [c["name"] for c in one["components"]] == ["ACT2.CH1.state"], "match reads labels too"
    assert one["components"][0]["family"] == "ACT", "narrowed: every field of each component"


async def test_daq_time_is_seconds_from_the_run_start(harness):
    t0 = 1791060364.5
    comps = [{"name": "PT1_Cal.CH5.pressure_psi", "unit": "psi", "label": "LOX Upstream"}]
    harness.fake.on(
        "daq-viewer",
        "GET",
        "/api/runs/r9/components",
        lambda req: httpx.Response(200, json={"t_min": t0, "components": comps}),
    )
    asked = {}

    def series(req):
        asked.update(req.url.params)
        return httpx.Response(
            200,
            json={"series": [{"name": "PT1_Cal.CH5.pressure_psi", "t": [t0 + 60, t0 + 61.5], "v": [1.0, None]}]},
        )

    harness.fake.on("daq-viewer", "GET", "/api/runs/r9/series", series)
    out = await harness.call_json(
        "daq_series", {"run_id": "r9", "components": ["PT1_Cal.CH5.pressure_psi"], "start": 60, "end": 120}
    )
    assert float(asked["start"]) == t0 + 60 and float(asked["end"]) == t0 + 120, "the viewer is asked in epoch"
    s = out["series"][0]
    assert s["t"] == [60.0, 61.5] and out["t0_epoch"] == t0
    assert s["unit"] == "psi" and s["label"] == "LOX Upstream"

    plot = await harness.call("daq_plot", {"run_id": "r9", "components": ["PT1_Cal.CH5.pressure_psi"], "start": 60})
    assert not plot["isError"] and float(asked["start"]) == t0 + 60


async def test_flight_dynamics_summary_and_table(harness):
    samples = [{"t": i * 0.1, "altitude": i * 10.0, "bendingMoment": 50.0 if i == 7 else 1.0} for i in range(100)]
    harness.fake.on(
        "openrocket",
        "POST",
        "/api/models/m1/flight-dynamics",
        lambda req: httpx.Response(
            200,
            json={
                "apogee": 990.0,
                "maxBendingMoment": 50.0,
                "samples": samples,
                "fft": {"frequency": [1] * 500, "amplitude": [1] * 500},
            },
        ),
    )
    out = await harness.call_json(
        "openrocket_flight_dynamics", {"model_id": "m1", "request": {"motor": {"motorId": "x"}}}
    )
    assert out["summary"]["maxBendingMoment"] == 50.0
    assert "fft" not in out["summary"] and "samples" not in out["summary"]
    sigs = {s[0]: s for s in out["table"]["signals"]}
    assert sigs["bendingMoment"][1] == "N·m"
    assert sigs["altitude"][1] == "m AGL"


async def test_run_design_loads_through_the_store_and_runs_the_backends_bodies(harness):
    config = {"cad": {"modelId": "m1"}, "recovery": {}}
    reqs = {
        "modelId": "m1",
        "flightDynamics": {"motor": {"motorId": "x"}, "overrides": {"occ:a": 1.0}},
        "stability": {},
        "ork": {},
        "recovery": {"vehicle": {}},
        "airframeBound": "axial",
    }
    posted = {}

    def flight(req):
        posted["flight"] = json.loads(req.content)
        return httpx.Response(200, json={"apogee": 1234.0, "maxBendingMoment": 9.0, "samples": []})

    def conv(req):
        posted["conv"] = json.loads(req.content)
        return httpx.Response(200, json=reqs)

    harness.fake.on(
        "openrocket", "GET", "/api/documents/d1/load", lambda req: httpx.Response(200, json={"config": config})
    )
    harness.fake.on("openrocket", "POST", "/api/design/requests", conv)
    harness.fake.on("openrocket", "POST", "/api/models/m1/flight-dynamics", flight)

    out = await harness.call_json("openrocket_run_design", {"design_id": "d1", "run": "flight", "owner": "bob"})
    assert out["summary"]["apogee"] == 1234.0
    assert posted["conv"] == {"config": config}, "the saved design goes to the backend unchanged"
    assert posted["flight"] == reqs["flightDynamics"], "and the backend's body is what runs"
    load = next(r for r in harness.fake.seen if r.url.path == "/api/documents/d1/load")
    assert load.url.params["owner"] == "bob"


def _serve_design(harness, reqs, posted):
    def conv(req):
        posted["conv"] = json.loads(req.content)
        return httpx.Response(200, json=reqs)

    def flight(req):
        posted["flight"] = json.loads(req.content)
        return httpx.Response(200, json={"apogee": 1.0, "samples": []})

    harness.fake.on(
        "openrocket", "GET", "/api/documents/d1/load", lambda req: httpx.Response(200, json={"config": {"cad": {}}})
    )
    harness.fake.on("openrocket", "POST", "/api/design/requests", conv)
    harness.fake.on("openrocket", "POST", "/api/models/m1/flight-dynamics", flight)


async def test_run_design_changes_replace_fields_and_leave_the_rest(harness):
    fd = {
        "motor": {"motorId": "old", "simfileId": "s-old", "aftOffset": 0.1, "state": "launch"},
        "railLength": 3.0,
        "overrides": {"occ:a": 1.0, "occ:b": 2.0},
        "site": None,
    }
    reqs = {"modelId": "m1", "flightDynamics": fd, "stability": {}, "ork": {}, "recovery": {}, "airframeBound": "axial"}
    posted: dict = {}
    _serve_design(harness, reqs, posted)
    changes = {"motor": {"motorId": "new", "simfileId": "s-new"}, "railLength": 6.0, "site": {"T_pad": 290}}
    out = await harness.call_json("openrocket_run_design", {"design_id": "d1", "run": "flight", "changes": changes})
    assert posted["flight"] == {
        "motor": {"motorId": "new", "simfileId": "s-new", "aftOffset": 0.1, "state": "launch"},
        "railLength": 6.0,
        "overrides": {"occ:a": 1.0, "occ:b": 2.0},
        "site": {"T_pad": 290},
    }
    assert out["changes"] == changes

    posted.clear()
    bad = await harness.call("openrocket_run_design", {"design_id": "d1", "run": "flight", "changes": {"rail": 6}})
    assert bad["isError"] and "no field 'rail'" in bad["content"][0]["text"]
    assert "flight" not in posted, "a misspelt field must not run the design unchanged"


async def test_design_requests_inline_when_small_link_when_large(harness):
    posted: dict = {}
    small = {
        "modelId": "m1",
        "stability": {"overrides": {"occ:a": 1.5}},
        "flightDynamics": {},
        "airframeBound": "axial",
    }
    _serve_design(harness, small, posted)
    assert await harness.call_json("openrocket_design_requests", {"design_id": "d1"}) == small

    masses = {f"occ:{i:04d}/" + "x" * 80: 0.5 for i in range(700)}
    large = {**small, "stability": {"overrides": masses, "outerFaces": [], "finFaces": [], "motor": None}}
    _serve_design(harness, large, posted)
    out = await harness.call_json("openrocket_design_requests", {"design_id": "d1"})
    assert out["summary"]["parts"] == 700 and out["summary"]["dryMassKg"] == 350.0
    assert len(json.dumps(out)) < 48_000
    full = await harness.client.get("/" + out["requests"]["url"].split("/", 3)[3])
    assert full.status_code == 200 and full.json() == large, "the link holds every body, nothing summarized"


async def test_optimizer_results_link_the_apps_csv_and_yaml(harness):
    results = {"time_array": [0, 1], "lox_pressure": [1, 2], "fuel_pressure": [3, 4], "config_yaml": "a: 1\n"}
    harness.fake.on(
        "engine-design",
        "GET",
        "/api/optimizer/layer2/results",
        lambda req: httpx.Response(200, json={"results": results}),
    )
    harness.fake.on(
        "engine-design",
        "GET",
        "/api/optimizer/layer2/results.csv",
        lambda req: httpx.Response(
            200,
            text="Time (s),LOX Pressure (Pa),Fuel Pressure (Pa)\n0,1,3\n1,2,4\n",
            headers={"content-disposition": 'attachment; filename="pressure_curves.csv"'},
        ),
    )
    out = await harness.call_json("engine_optimizer_results", {"layer": 2})
    assert out["pressure_curves_csv"]["filename"] == "pressure_curves.csv"
    assert out["config_yaml"]["filename"] == "layer2-config.yaml"
    assert "config_yaml" not in out["results"]


async def test_feedtwin_session_csv_is_the_apps_file(harness):
    csv = "t_s,state,LOX tank [psia]\n0.000,Ready,14.696"
    harness.fake.on(
        "feed-twin",
        "GET",
        "/api/session/s1/history.csv",
        lambda req: httpx.Response(
            200, text=csv, headers={"content-disposition": 'attachment; filename="feed-twin-s1-3s.csv"'}
        ),
    )
    link = await harness.call_json("feedtwin_session_csv", {"session_id": "s1"})
    assert link["filename"] == "feed-twin-s1-3s.csv"
    got = await harness.client.get("/" + link["url"].split("/", 3)[3])
    assert got.text == csv


async def test_pid_image_link_checks_access_then_links_the_diagram(harness):
    harness.app.state.ctx.settings = harness.app.state.ctx.settings.__class__(
        **{**harness.app.state.ctx.settings.__dict__, "pid_designer_public_url": "https://pid.example.org"}
    )
    harness.fake.on("pid-designer", "GET", "/api/pid/diagrams/d1/load", lambda req: httpx.Response(200, json={}))
    out = await harness.call_json("pid_image_link", {"design_id": "d1", "owner": "bob@berkeley.edu"})
    assert out["url"] == "https://pid.example.org/?diagram=d1&owner=bob%40berkeley.edu"
    harness.fake.on(
        "pid-designer",
        "GET",
        "/api/pid/diagrams/d2/load",
        lambda req: httpx.Response(403, json={"detail": "not shared"}),
    )
    denied = await harness.call("pid_image_link", {"design_id": "d2"})
    assert denied["isError"], "no link to a diagram you cannot see"
