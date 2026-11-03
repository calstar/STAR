"""star-openrocket: CAD models, motors, the 6-DOF ascent, the recovery descent, the .ork.

The simulations run from a **saved design**: ``openrocket_run_design`` loads it
through the document store (so its sharing rules apply) and asks the app's backend
to turn it into the request bodies (``POST /api/design/requests``,
star-openrocket/backend/design_requests.py) -- the same conversion the browser does
before Simulate (frontend/src/lib/designRequests.ts), held to the same test
fixtures. The raw-body tools stay for a what-if: take the bodies from
``openrocket_design_requests``, change one number, run it.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from mcp.server.mcpserver.exceptions import ToolError

from .. import identity
from ..data import compact
from ..files import FileStore, safe_filename
from ..tables import from_records
from . import COMPUTE, READ, Ctx

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
        backend the same way the browser builds them. Use it to see (or tweak) what
        openrocket_run_design would run."""
        return compact(await _design_requests(ctx, design_id, owner, version, release), max_list=200)

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def openrocket_run_design(
        design_id: str,
        run: Literal["flight", "stability", "recovery", "ork"],
        owner: str | None = None,
        version: str | None = None,
        release: str | None = None,
    ) -> dict[str, Any]:
        """Run a saved openrocket design exactly as the app would: `flight` the 6-DOF ascent (apogee,
        max speed/Mach/accel/q, max bending moment, rail exit, margins, drift + a table), `stability`
        (CP, CG, margin), `recovery` the descent at the design's airframe bound and the other one
        (peak loads per chute, every failure case), `ork` the .ork file as a link. A design shared
        with you needs `owner` (from list_designs)."""
        reqs = await _design_requests(ctx, design_id, owner, version, release)
        mid = reqs["modelId"]
        which = {"version": version} if version else {"release": release} if release else {"working_copy": True}
        head = {"design_id": design_id, **which, "model_id": mid}
        if run == "flight":
            return {**head, **await _flight(ctx, mid, reqs["flightDynamics"])}
        if run == "stability":
            return {**head, "stability": await _stability(ctx, mid, reqs["stability"])}
        if run == "ork":
            return {**head, "ork": await _ork(ctx, mid, reqs["ork"])}
        return {
            **head,
            "airframe_bound": reqs["airframeBound"],
            "recovery": await _recovery(ctx, reqs["recovery"], "both"),
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
