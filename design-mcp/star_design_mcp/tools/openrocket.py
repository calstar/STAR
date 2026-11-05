"""star-openrocket: CAD models, motors, the 6-DOF ascent, the recovery descent, the .ork.

The simulations run from a **saved design**: ``openrocket_run_design`` loads it
through the document store (so its sharing rules apply) and asks the app's backend
to turn it into the request bodies (``POST /api/design/requests``,
star-openrocket/backend/design_requests.py) -- the same conversion the browser does
before Simulate (frontend/src/lib/designRequests.ts), held to the same test
fixtures. A what-if is ``openrocket_run_design(..., changes=...)``: the saved
design's body with a few fields replaced, so a 680-part model's masses never
travel through the agent. The raw-body tools stay for a body built from scratch.
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from mcp.server.mcpserver.exceptions import ToolError

from .. import identity
from ..data import compact
from ..files import FileStore, safe_filename
from ..tables import from_records
from . import COMPUTE, READ, Ctx
from .documents import INLINE_BYTES

MODEL_ID = re.compile(r"^[A-Za-z0-9_-]{1,120}$")

#: Units of the 6-DOF samples, as documented on FlightDynamicsResult in
#: star-openrocket/backend/onshape/aero/rocketpy_flight.py.
FLIGHT_UNITS = {
    "altitude": "m AGL",
    "speed": "m/s",
    "mach": "-",
    "acceleration": "m/s^2",
    "dynamicPressure": "Pa",
    "windSpeed": "m/s",
    "angleOfAttack": "deg",
    "angleFromVertical": "deg",
    "stabilityMarginRocketpy": "cal",
    "stabilityMarginOurs": "cal",
    "driftX": "m east",
    "driftY": "m north",
    "bendingMoment": "N·m",
    "omegaPitch": "rad/s",
}


def _model(model_id: str) -> str:
    if not MODEL_ID.match(model_id):
        raise ToolError(f"Not a model id: {model_id!r} (from openrocket_list_models).")
    return model_id


def register(server, ctx: Ctx) -> None:
    @server.tool(annotations=READ, structured_output=False)
    async def openrocket_list_models() -> Any:
        """CAD models star-openrocket has built from Onshape (ids for the other openrocket_* tools)."""
        return compact(await ctx.apps.get_json("openrocket", "/api/models"), max_list=200)

    @server.tool(annotations=READ, structured_output=False)
    async def openrocket_model(model_id: str) -> Any:
        """A model's manifest: source document, parts with masses/materials, bounding geometry."""
        return compact(
            await ctx.apps.get_json("openrocket", f"/api/models/{_model(model_id)}/manifest.json"), max_list=60
        )

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def openrocket_model_glb(model_id: str) -> dict[str, Any]:
        """The model's 3D mesh (.glb) as a download link."""
        _model(model_id)
        return await _cached_download(ctx, f"/api/models/{model_id}/model.glb", f"{model_id}.glb", "model/gltf-binary")

    @server.tool(annotations=READ, structured_output=False)
    async def openrocket_motor(motor_id: str) -> Any:
        """A motor from the catalog mirror: designation, impulse, burn time, mass, available sim files."""
        return compact(await ctx.apps.get_json("openrocket", f"/api/motors/{motor_id}"), max_list=60)

    @server.tool(annotations=READ, structured_output=False)
    async def openrocket_search_motors(query: str = "", impulse_class: str = "", limit: int = 20) -> Any:
        """Search the motor catalog mirror (the app's motor picker): free text and/or an impulse
        class letter (e.g. 'M')."""
        rows = await ctx.apps.get_json(
            "openrocket",
            "/api/motors",
            query=query or None,
            impulseClass=impulse_class or None,
            limit=max(1, min(limit, 100)),
        )
        return compact(rows, max_list=100)

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def openrocket_motor_file(motor_id: str, simfile_id: str | None = None) -> dict[str, Any]:
        """A motor's thrust-curve file (.eng/.rse) as a download link."""
        return await _cached_download(
            ctx,
            f"/api/motors/{motor_id}/file",
            f"{motor_id}.eng",
            "text/plain",
            params={"simfileId": simfile_id},
        )

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def openrocket_design_requests(
        design_id: str, owner: str | None = None, version: str | None = None, release: str | None = None
    ) -> dict[str, Any]:
        """A saved openrocket design as the exact request bodies its simulations take -- per-part
        masses, faces, motor, rail, site, wind, devices, the recovery Config -- built by the app's
        backend the same way the browser builds them. Use it to see what openrocket_run_design would
        run, and which fields its `changes` can replace. A large model's bodies (hundreds of per-part
        masses) come back as a JSON link plus a summary."""
        reqs = await _design_requests(ctx, design_id, owner, version, release)
        text = json.dumps(reqs)
        if len(text) <= INLINE_BYTES:
            return reqs
        name = safe_filename(f"openrocket-{design_id}-{version or release or 'working'}-requests.json")
        stored = ctx.files.put_bytes(text.encode(), name, "application/json")
        return {
            "design_id": design_id,
            "summary": _summarize_requests(reqs),
            "requests": ctx.link(stored),
            "note": "The full bodies are in the link. For a what-if, pass the fields to change to "
            "openrocket_run_design(changes=...) instead of sending a body back.",
        }

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def openrocket_run_design(
        design_id: str,
        run: Literal["flight", "stability", "recovery", "ork"],
        owner: str | None = None,
        version: str | None = None,
        release: str | None = None,
        changes: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Run a saved openrocket design exactly as the app would: `flight` the 6-DOF ascent (apogee,
        max speed/Mach/accel/q, max bending moment, rail exit, margins, drift + a table; the summary's
        peaks are full-resolution, the table is the app's 300-point resample), `stability` (CP, CG,
        margin), `recovery` the descent at the design's airframe bound and the other one (peak loads
        per chute, every failure case), `ork` the .ork file as a link. A design shared with you needs
        `owner` (from list_designs).

        `changes` is a what-if: fields merged into that run's request body before it runs (objects
        merge key by key, anything else replaces), e.g. {"motor": {"motorId": "...", "simfileId":
        "..."}} or {"railLength": 6}. openrocket_design_requests shows the body's fields. The saved
        design is not touched; the result says what was changed."""
        reqs = await _design_requests(ctx, design_id, owner, version, release)
        mid = reqs["modelId"]
        which = {"version": version} if version else {"release": release} if release else {"working_copy": True}
        head: dict[str, Any] = {"design_id": design_id, **which, "model_id": mid}
        if changes:
            head["changes"] = changes
        key = {"flight": "flightDynamics", "stability": "stability", "ork": "ork", "recovery": "recovery"}[run]
        body = _merge(reqs[key], changes or {}, key)
        if run == "flight":
            return {**head, **await _flight(ctx, mid, body)}
        if run == "stability":
            return {**head, "stability": await _stability(ctx, mid, body)}
        if run == "ork":
            return {**head, "ork": await _ork(ctx, mid, body)}
        return {
            **head,
            "airframe_bound": reqs["airframeBound"],
            "recovery": await _recovery(ctx, body, "both"),
        }

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def openrocket_flight_dynamics(model_id: str, request: dict[str, Any]) -> dict[str, Any]:
        """Run the 6-DOF ascent with an explicit FlightDynamicsRequest body (openrocket_design_requests
        shows one; prefer openrocket_run_design for a saved design). Returns the headline numbers plus
        a table_id for the time series. Runs as a job (can exceed a minute)."""
        return await _flight(ctx, _model(model_id), request)

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def openrocket_stability(model_id: str, request: dict[str, Any]) -> Any:
        """Static stability (CP, CG, margin) with an explicit StabilityRequest body."""
        return await _stability(ctx, _model(model_id), request)

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def openrocket_export_ork(model_id: str, request: dict[str, Any]) -> dict[str, Any]:
        """The .ork as a download link, from an explicit OrkExportRequest body."""
        return await _ork(ctx, _model(model_id), request)

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def openrocket_recovery(
        config: dict[str, Any],
        bound: Literal["axial", "broadside", "both"] = "both",
    ) -> Any:
        """The recovery descent from an explicit wire-form Config: every failure case per parachute,
        with peak loads, descent rates and drift. `both` returns the axial and broadside airframe-drag
        bounds side by side (the attitude band moves the design load ~2x)."""
        return await _recovery(ctx, config, bound)

    @server.tool(annotations=READ, structured_output=False)
    async def openrocket_recovery_devices(query: str | None = None, limit: int = 50) -> Any:
        """The recovery device catalog (parachutes and their vendors), for building a recovery config.
        `query` matches SKU, model or vendor."""
        return compact(
            await ctx.apps.get_json("openrocket", "/api/devices", q=query, limit=max(1, min(limit, 500))),
            max_list=200,
        )


def _merge(base: Any, changes: Any, path: str) -> Any:
    """``base`` with ``changes`` laid over it: objects merge key by key, anything else replaces.
    A key the body does not have is refused, so a misspelt field cannot run unchanged."""
    if not isinstance(changes, dict):
        return changes
    if not isinstance(base, dict):
        raise ToolError(f"changes: {path} is not an object in the request body, so it cannot take fields.")
    out = dict(base)
    for k, v in changes.items():
        if k not in base:
            raise ToolError(
                f"changes: {path} has no field {k!r} (it has {', '.join(sorted(base))}). "
                "openrocket_design_requests shows the body."
            )
        out[k] = _merge(base[k], v, f"{path}.{k}") if isinstance(v, dict) and base[k] is not None else v
    return out


def _summarize_requests(reqs: dict[str, Any]) -> dict[str, Any]:
    """What a person would want to see of the bodies without the per-part lists."""
    st = reqs.get("stability") or {}
    fd = reqs.get("flightDynamics") or {}
    masses = st.get("overrides") or {}
    summary: dict[str, Any] = {
        "modelId": reqs.get("modelId"),
        "parts": len(masses),
        "dryMassKg": sum(v for v in masses.values() if isinstance(v, (int, float))),
        "outerFaces": len(st.get("outerFaces") or []),
        "finFaces": len(st.get("finFaces") or []),
        "motor": st.get("motor"),
        "flightDynamics": {k: v for k, v in fd.items() if k not in ("overrides", "outerFaces", "finFaces")},
        "airframeBound": reqs.get("airframeBound"),
        "recoverySources": reqs.get("recoverySources"),
    }
    return compact(summary, max_list=40)


async def _design_requests(ctx: Ctx, design_id, owner, version, release) -> dict[str, Any]:
    """Load the design through the document store (its access check), then ask the app's
    backend to turn it into request bodies (POST /api/design/requests)."""
    if version and release:
        raise ToolError("Pass version or release, not both.")
    base = f"/api/documents/{design_id}"
    path = f"{base}/version/{version}" if version else f"{base}/release/{release}" if release else f"{base}/load"
    doc = await ctx.apps.get_json("openrocket", path, owner=owner)
    config = doc.get("config") if isinstance(doc, dict) else None
    if not isinstance(config, dict) or not config:
        raise ToolError(f"Design {design_id!r} has no saved config.")
    return await ctx.apps.post_json("openrocket", "/api/design/requests", {"config": config})


async def _flight(ctx: Ctx, model_id: str, request: dict[str, Any]) -> dict[str, Any]:
    async def work() -> dict[str, Any]:
        body = await ctx.apps.post_json("openrocket", f"/api/models/{model_id}/flight-dynamics", request)
        samples = body.pop("samples", None) or []
        body.pop("fft", None)
        out: dict[str, Any] = {"model_id": model_id, "units": "SI; see table signals", "summary": compact(body)}
        if samples:
            table_id = ctx.tables.table_id("openrocket-flight", model_id, request)
            out["table"] = ctx.tables.save(
                table_id,
                from_records(samples, FLIGHT_UNITS),
                source={
                    "app": "openrocket",
                    "kind": "flight-dynamics",
                    "model_id": model_id,
                    "label": f"6-DOF ascent, {model_id}",
                },
                filename=f"flight-{model_id}.parquet",
            )
        return out

    return await ctx.jobs.run(f"openrocket 6-DOF {model_id}", work)


async def _stability(ctx: Ctx, model_id: str, request: dict[str, Any]) -> Any:
    return compact(await ctx.apps.post_json("openrocket", f"/api/models/{model_id}/stability", request))


async def _ork(ctx: Ctx, model_id: str, request: dict[str, Any]) -> dict[str, Any]:
    key = FileStore.memo_key(identity.current().email, "ork", model_id, request)

    async def work() -> dict[str, Any]:
        hit = ctx.files.memo_get(key)
        if hit:
            return ctx.link(hit)
        r = await ctx.apps.request("openrocket", "POST", f"/api/models/{model_id}/export.ork", json=request)
        stored = ctx.files.put_bytes(r.content, f"{model_id}.ork", "application/octet-stream")
        ctx.files.memo_put(key, stored)
        return ctx.link(stored)

    return await ctx.jobs.run(f"openrocket ork {model_id}", work)


async def _recovery(ctx: Ctx, config: dict[str, Any], bound: str) -> Any:
    if bound == "both":
        body = await ctx.apps.post_json("openrocket", "/api/simulate/both", config)
    else:
        body = await ctx.apps.post_json("openrocket", "/api/simulate", config, which=bound)
    return compact(body, max_list=30)


async def _cached_download(
    ctx: Ctx, path: str, filename: str, mime: str, *, params: dict[str, Any] | None = None
) -> dict[str, Any]:
    key = FileStore.memo_key(identity.current().email, "openrocket", path, params or {})
    hit = ctx.files.memo_get(key)
    if hit:
        return ctx.link(hit)
    f, tmp = ctx.files.new_temp()
    try:
        with f:
            await ctx.apps.stream_to("openrocket", path, f, params=params)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    stored = ctx.files.adopt(tmp, safe_filename(filename), mime)
    ctx.files.memo_put(key, stored)
    return ctx.link(stored)
