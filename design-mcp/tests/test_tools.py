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
