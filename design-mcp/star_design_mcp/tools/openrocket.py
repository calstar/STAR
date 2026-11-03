"""star-openrocket: CAD models, motors, the 6-DOF ascent, the recovery descent, the .ork.

The simulations take the same request bodies the app's own UI posts, passed
through unchanged:

- ascent / .ork: ``FlightDynamicsRequest`` / ``OrkExportRequest``
  (star-openrocket/backend/main.py) -- face selections, per-part masses, motor,
  rail, inclination, heading, wind, site (and devices for the .ork);
- descent: the recovery ``Config`` (backend/recovery/schema.py) in its wire form.

They are *not* rebuilt here from a saved design. Today the browser turns a
design into those bodies (per-part masses from the manifest, overrides and hidden
parts; the recovery slice through ``toWireConfig``), and a second copy of that
logic in this server would drift from the UI's and give different answers. Moving
it into the app's backend is the follow-up that lets a tool take just a design id.
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
    async def openrocket_flight_dynamics(model_id: str, request: dict[str, Any]) -> dict[str, Any]:
        """Run the 6-DOF RocketPy ascent for a model. `request` is the app's FlightDynamicsRequest:
        {outerFaces, finFaces, nFins, overrides (occurrence key -> kg), motor {motorId, simfileId,...},
        railLength, inclination, heading, wind, site}. Returns the headline numbers -- apogee, max
        speed/Mach/acceleration/q, max bending moment, rail-exit speed and margin, min margin, drift
        -- plus a table_id for the time series. Runs as a job (can exceed a minute)."""
        _model(model_id)

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

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def openrocket_stability(model_id: str, request: dict[str, Any]) -> Any:
        """Static stability for a model: CP, CG and margin. `request` is the app's StabilityRequest
        {outerFaces, finFaces, nFins, overrides, axis, motor}."""
        _model(model_id)
        return compact(await ctx.apps.post_json("openrocket", f"/api/models/{model_id}/stability", request))

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def openrocket_export_ork(model_id: str, request: dict[str, Any]) -> dict[str, Any]:
        """The model as an OpenRocket .ork download link. `request` is the app's OrkExportRequest: the
        FlightDynamicsRequest fields plus `devices` (the recovery devices, as /api/simulate takes them)."""
        _model(model_id)
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

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def openrocket_recovery(
        config: dict[str, Any],
        bound: Literal["axial", "broadside", "both"] = "both",
    ) -> Any:
        """The recovery descent for a vehicle: every failure case per parachute, with peak loads,
        descent rates and drift. `config` is the recovery Config in wire form {vehicle, site, devices,
        ...}. `both` returns the axial and broadside airframe-drag bounds side by side (the honest
        default: the attitude band moves the design load ~2x)."""
        if bound == "both":
            body = await ctx.apps.post_json("openrocket", "/api/simulate/both", config)
        else:
            body = await ctx.apps.post_json("openrocket", "/api/simulate", config, which=bound)
        return compact(body, max_list=30)

    @server.tool(annotations=READ, structured_output=False)
    async def openrocket_recovery_devices(query: str | None = None, limit: int = 50) -> Any:
        """The recovery device catalog (parachutes and their vendors), for building a recovery config.
        `query` matches SKU, model or vendor."""
        return compact(
            await ctx.apps.get_json("openrocket", "/api/devices", q=query, limit=max(1, min(limit, 500))),
            max_list=200,
        )


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
