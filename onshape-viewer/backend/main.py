"""Standalone FastAPI backend for the Onshape CM Viewer.

Run with:
    cd onshape-viewer
    uvicorn backend.main:app --reload --port 8002

Serves build artifacts, and -- since the model picker landed -- also brokers
Onshape calls on the caller's behalf, for searching documents and for running a
build.

That last part is a deliberate change of posture and is worth stating plainly.
This server previously had no code path from an HTTP request to an Onshape API
key; it now has one. The keys still never leave the process: the browser
receives search results and build artifacts, never a credential. But anyone who
can reach this port can spend the key pair's rate limit and read any document
the key can read. It binds localhost for development, and it must not be
exposed to a network without authentication in front of it.
"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .onshape.aero.axis import Axis
from .onshape.aero.fins import (
    count_fins,
    detect_fin_faces,
    extract_fin_planform,
    planform_outline_3d,
)
from .onshape.aero.outer_surface import detect_outer_surface
from .onshape.aero.profile import build_profile
from .onshape.aero.flight import simulate_flight
from .onshape.aero.rocketpy_flight import simulate_flight_dynamics
from .onshape.aero.stability import MotorPlacement, compute_stability
from .onshape.browse import BrowseCache
from .onshape.build import build as run_build
from .onshape.client import MissingCredentials, OnshapeClient, OnshapeError
from .onshape.geometry_store import GeometryStore
from .motors.db import MotorDB

CACHE_ROOT = Path(__file__).resolve().parent.parent / "cache"

#: Lives beside the model directories. `_model_dirs` only considers directories
#: holding a manifest, so a loose file here is invisible to the model list.
_browse = BrowseCache(CACHE_ROOT / "browse.json")

#: Global (not per-model) motor catalog mirrored from thrustcurve.org by
#: `python -m backend.motors.fetch`. Offline; empty until that runs.
_motor_db = MotorDB(CACHE_ROOT / "motors")

app = FastAPI(title="Onshape CM Viewer API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5175",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5175",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Versioned designs: per-user documents with autosaved working copy, microversion
# history and immutable releases (local files in dev; S3 when the bucket env is set).
from .routers import documents  # noqa: E402

app.include_router(documents.router)


def _model_dirs() -> list[Path]:
    if not CACHE_ROOT.exists():
        return []
    return sorted(d for d in CACHE_ROOT.iterdir() if (d / "manifest.json").exists())


@app.get("/api/health")
async def health():
    return {"status": "healthy"}


@app.get("/api/models")
async def list_models():
    """Every built model in the cache, newest build first."""
    models = []
    for directory in _model_dirs():
        try:
            manifest = json.loads((directory / "manifest.json").read_text())
        except (OSError, json.JSONDecodeError):
            continue
        source = manifest.get("source", {})
        models.append(
            {
                "id": directory.name,
                "documentName": source.get("documentName"),
                "assemblyName": source.get("assemblyName"),
                "builtAt": source.get("builtAt"),
                "partCount": manifest.get("totals", {}).get("partCount"),
                "partsWithoutMaterial": manifest.get("totals", {}).get(
                    "partsWithoutMaterial"
                ),
            }
        )
    models.sort(key=lambda m: m.get("builtAt") or "", reverse=True)
    return models


def _resolve(model_id: str, filename: str) -> Path:
    # Reject traversal before touching the filesystem: model_id comes straight
    # from the URL and is used as a path segment.
    if "/" in model_id or "\\" in model_id or model_id.startswith("."):
        raise HTTPException(status_code=400, detail="invalid model id")
    path = CACHE_ROOT / model_id / filename
    if not path.exists():
        raise HTTPException(
            status_code=404, detail=f"{filename} not found for model {model_id}"
        )
    return path


@app.get("/api/models/{model_id}/manifest.json")
async def get_manifest(model_id: str):
    return FileResponse(
        _resolve(model_id, "manifest.json"), media_type="application/json"
    )


@app.get("/api/models/{model_id}/model.glb")
async def get_glb(model_id: str):
    return FileResponse(
        _resolve(model_id, "model.glb"),
        media_type="model/gltf-binary",
        # Artifacts are keyed on an immutable ref, so they can never change
        # under a client that has already fetched them.
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


# -- Stability / centre of pressure -------------------------------------------
#
# All aerodynamic + CG maths runs here, offline: it reads the geometry sidecar
# and manifest a build already wrote, and never touches Onshape. This is the
# single source of truth for CG, CoP and static margin, so both halves of the
# margin come from one code path (see aero/stability.py).


class FaceRef(BaseModel):
    key: str  # occurrence key ("occ:<path>")
    faceId: str


class AxisInput(BaseModel):
    origin: list[float]
    direction: list[float]


class MotorSelection(BaseModel):
    #: thrustcurve.org motor id, and which datafile of it (None = best available).
    motorId: str
    simfileId: str | None = None
    #: Offset of the motor's aft end from its datum (m), aft-positive. The datum is the
    #: airframe base by default, or ``refFace`` when given. 0 = aft-flush / at the face.
    aftOffset: float = 0.0
    #: Optional face to measure the aft end from; must be normal to the rocket axis.
    refFace: FaceRef | None = None
    #: "launch" (wet) or "burnout" (dry) -- picks which end of the mass table to use.
    state: str = "launch"


class StabilityRequest(BaseModel):
    #: Approved outer airframe faces. Empty means "auto-detect them for me".
    outerFaces: list[FaceRef] = []
    #: Approved fin faces. None means auto-detect; [] means "no fins".
    finFaces: list[FaceRef] | None = None
    #: Override the detected fin count (e.g. a partial selection).
    nFins: int | None = None
    #: Occurrence key -> resolved mass (kg), overriding the manifest mass. This
    #: is how a mass typed in for a material-less part reaches the CG.
    overrides: dict[str, float] = {}
    #: Optional user-confirmed axis; auto-detected from the surface when absent.
    axis: AxisInput | None = None
    #: Optional motor to fold into the CG / static margin.
    motor: MotorSelection | None = None
    #: Guided rail length (m) for the flight sim's off-rail velocity. Ignored by /stability.
    railLength: float | None = None


class FlightDynamicsRequest(StabilityRequest):
    """A StabilityRequest plus the launch conditions the 6-DOF RocketPy flight needs."""

    #: Rail inclination from horizontal (deg); 90 = vertical.
    inclination: float = 85.0
    #: Rail heading / azimuth (deg from north).
    heading: float = 0.0
    #: Constant wind speed (m/s) and the compass bearing it blows *from* (deg).
    windSpeed: float = 0.0
    windDirection: float = 0.0


def _model_dir(model_id: str) -> Path:
    if "/" in model_id or "\\" in model_id or model_id.startswith("."):
        raise HTTPException(status_code=400, detail="invalid model id")
    path = CACHE_ROOT / model_id
    if not (path / "manifest.json").exists():
        raise HTTPException(status_code=404, detail=f"unknown model {model_id}")
    return path


def _load_store(model_dir: Path) -> GeometryStore:
    if not GeometryStore.exists(model_dir):
        # Older builds predate the sidecar; there is no way to analyse them
        # without rebuilding, and rebuilding is a deliberate, credentialed act.
        raise HTTPException(
            status_code=409,
            detail="this model has no geometry sidecar; rebuild it to enable stability analysis",
        )
    try:
        return GeometryStore.load(model_dir)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


def _axis_payload(axis: Axis) -> dict:
    return {"origin": axis.origin.tolist(), "direction": axis.direction.tolist()}


@app.get("/api/models/{model_id}/outer-surface")
async def outer_surface(model_id: str):
    """Auto-detected outer airframe faces, for the approval UI to seed from."""
    store = _load_store(_model_dir(model_id))
    try:
        guess = detect_outer_surface(store)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "faces": [{"key": k, "faceId": f} for k, f in guess.faces],
        "axis": _axis_payload(guess.axis),
    }


@app.get("/api/models/{model_id}/fins")
async def fins(model_id: str):
    """Auto-detected fin faces + count, for the approval UI to seed from."""
    store = _load_store(_model_dir(model_id))
    try:
        guess = detect_outer_surface(store)
        all_faces = store.iter_faces()
        skin = store.faces_for(guess.faces)
        import numpy as np

        profile, axis = build_profile(np.concatenate([f.triangles for f in skin]), axis=guess.axis)
        fin_faces = detect_fin_faces(all_faces, axis, profile.r_max)
        fin_geo = store.faces_for(fin_faces)
        count = 0
        planforms: list = []
        if fin_geo:
            pf = extract_fin_planform(fin_geo, axis, profile.r_max)
            count = pf.n_fins
            planforms = [planform_outline_3d(pf, axis, az) for az in pf.azimuths]
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "faces": [{"key": k, "faceId": f} for k, f in fin_faces],
        "count": count,
        "axis": _axis_payload(axis),
        "bodyRadius": profile.r_max,
        # The exposed fin planforms, so Auto-detect shows the same surface Compute
        # does (rooted at the body, tab excluded) rather than nothing.
        "planforms": planforms,
    }


@app.post("/api/models/{model_id}/stability")
async def stability(model_id: str, request: StabilityRequest):
    """CG, CoP and static margin from an approved outer-surface selection."""
    model_dir = _model_dir(model_id)
    store = _load_store(model_dir)
    manifest = json.loads((model_dir / "manifest.json").read_text())

    faces = [(f.key, f.faceId) for f in request.outerFaces]
    axis = None
    if not faces:
        faces = detect_outer_surface(store).faces
    if request.axis is not None:
        import numpy as np

        axis = Axis(
            origin=np.asarray(request.axis.origin, dtype=float),
            direction=np.asarray(request.axis.direction, dtype=float)
            / (np.linalg.norm(request.axis.direction) or 1.0),
        )

    fin_faces = (
        [(f.key, f.faceId) for f in request.finFaces] if request.finFaces is not None else None
    )

    motor_placement, motor_block = _resolve_motor(request.motor)

    try:
        result = compute_stability(
            store,
            manifest_parts=manifest.get("parts", []),
            outer_faces=faces,
            axis=axis,
            overrides=request.overrides,
            fin_faces=fin_faces,
            n_fins=request.nFins,
            motor=motor_placement,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if motor_block is not None:
        motor_block["cgFromNose"] = result.motor_cg_from_nose
        motor_block["aftFromBase"] = result.motor_aft_from_base
        motor_block["aftWorld"] = result.motor_aft_world
        motor_block["foreWorld"] = result.motor_fore_world
        motor_block["radius"] = result.motor_radius
        motor_block["cgWorld"] = result.motor_cg_world

    return {
        "cg": {"world": result.cg_world, "fromNose": result.cg_from_nose},
        "cp": {"world": result.cp_world, "fromNose": result.cp_from_nose},
        "axisDirection": result.axis_direction,
        "cna": result.cna,
        "refDiameter": result.ref_diameter,
        "rMax": result.r_max,
        "staticMargin": result.static_margin,
        "bodyLength": result.body_length,
        "mass": result.mass,
        "fins": {
            "count": result.n_fins,
            "cna": result.fin_cna,
            "rootChord": result.fin_root_chord,
            "tipChord": result.fin_tip_chord,
            "sweep": result.fin_sweep,
            "span": result.fin_span,
            "area": result.fin_area,
            "planforms": result.fin_planforms,
            "symmetric": result.fin_symmetric,
        },
        "motor": motor_block,
    }


@app.post("/api/models/{model_id}/flight")
async def flight(model_id: str, request: StabilityRequest):
    """Ascent flight profile (altitude/velocity/acceleration + static margin over time).

    A motor is required. 1-DOF, thrust minus weight, no drag yet (see aero/flight.py), so the
    apogee is an upper bound until the atmosphere model lands.
    """
    if request.motor is None:
        raise HTTPException(status_code=422, detail="a motor is required to simulate a flight")

    model_dir = _model_dir(model_id)
    store = _load_store(model_dir)
    manifest = json.loads((model_dir / "manifest.json").read_text())

    faces = [(f.key, f.faceId) for f in request.outerFaces]
    axis = None
    if not faces:
        faces = detect_outer_surface(store).faces
    if request.axis is not None:
        import numpy as np

        axis = Axis(
            origin=np.asarray(request.axis.origin, dtype=float),
            direction=np.asarray(request.axis.direction, dtype=float)
            / (np.linalg.norm(request.axis.direction) or 1.0),
        )
    fin_faces = (
        [(f.key, f.faceId) for f in request.finFaces] if request.finFaces is not None else None
    )

    motor_obj = _motor_db.get_motor(request.motor.motorId, request.motor.simfileId)
    if motor_obj is None:
        raise HTTPException(
            status_code=404,
            detail=f"unknown motor {request.motor.motorId} (has the catalog been fetched?)",
        )
    placement, motor_block = _resolve_motor(request.motor)

    rail_length = request.railLength if request.railLength and request.railLength > 0 else 1.0
    try:
        result = simulate_flight(
            store,
            manifest_parts=manifest.get("parts", []),
            outer_faces=faces,
            motor=motor_obj,
            placement=placement,
            axis=axis,
            overrides=request.overrides,
            fin_faces=fin_faces,
            n_fins=request.nFins,
            rail_length=rail_length,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    samples = [
        {
            "t": result.times[i],
            "altitude": result.altitude[i],
            "velocity": result.velocity[i],
            "acceleration": result.acceleration[i],
            "thrust": result.thrust[i],
            "mass": result.mass[i],
            "staticMargin": result.static_margin[i],
            "mach": result.mach[i],
        }
        for i in range(len(result.times))
    ]
    return {
        "motor": {"name": motor_block["name"], "format": motor_block["format"]},
        "samples": samples,
        "apogee": result.apogee,
        "apogeeTime": result.apogee_time,
        "maxVelocity": result.max_velocity,
        "maxAcceleration": result.max_acceleration,
        "burnoutTime": result.burnout_time,
        "burnoutAltitude": result.burnout_altitude,
        "burnoutVelocity": result.burnout_velocity,
        "liftoffMass": result.liftoff_mass,
        "thrustToWeight": result.thrust_to_weight,
        "liftoff": result.liftoff,
        "railLength": result.rail_length,
        "railExitVelocity": result.rail_exit_velocity,
        "railExitTime": result.rail_exit_time,
        "railCleared": result.rail_cleared,
        "minStaticMargin": result.min_static_margin,
        "minMarginTime": result.min_margin_time,
        "minMarginMach": result.min_margin_mach,
    }


@app.post("/api/models/{model_id}/flight-dynamics")
async def flight_dynamics(model_id: str, request: FlightDynamicsRequest):
    """6-DOF ascent via RocketPy: full trajectory, stability, loads and drift to apogee.

    Requires a motor and the optional ``rocketpy`` dependency. Aero uses native
    RocketPy surfaces; the stability panel overlays our CP(M) margin against RocketPy's.
    """
    if request.motor is None:
        raise HTTPException(status_code=422, detail="a motor is required to simulate a flight")

    model_dir = _model_dir(model_id)
    store = _load_store(model_dir)
    manifest = json.loads((model_dir / "manifest.json").read_text())

    faces = [(f.key, f.faceId) for f in request.outerFaces]
    if not faces:
        faces = detect_outer_surface(store).faces
    axis = None
    if request.axis is not None:
        import numpy as np

        axis = Axis(
            origin=np.asarray(request.axis.origin, dtype=float),
            direction=np.asarray(request.axis.direction, dtype=float)
            / (np.linalg.norm(request.axis.direction) or 1.0),
        )
    fin_faces = (
        [(f.key, f.faceId) for f in request.finFaces] if request.finFaces is not None else None
    )

    placement, motor_block = _resolve_motor(request.motor)
    motor_obj = _motor_db.get_motor(request.motor.motorId, request.motor.simfileId)
    if motor_obj is None:
        raise HTTPException(status_code=404, detail=f"unknown motor {request.motor.motorId}")

    rail_length = request.railLength if request.railLength and request.railLength > 0 else 1.0
    try:
        result = simulate_flight_dynamics(
            store,
            manifest_parts=manifest.get("parts", []),
            outer_faces=faces,
            motor=motor_obj,
            placement=placement,
            axis=axis,
            overrides=request.overrides,
            fin_faces=fin_faces,
            n_fins=request.nFins,
            rail_length=rail_length,
            inclination=request.inclination,
            heading=request.heading,
            wind_speed=request.windSpeed,
            wind_direction=request.windDirection,
        )
    except ModuleNotFoundError as exc:
        raise HTTPException(
            status_code=501,
            detail="rocketpy is not installed; install requirements-flight.txt to run flight dynamics",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    samples = [
        {
            "t": result.times[i],
            "altitude": result.altitude[i],
            "speed": result.speed[i],
            "mach": result.mach[i],
            "acceleration": result.acceleration[i],
            "dynamicPressure": result.dynamic_pressure[i],
            "angleOfAttack": result.angle_of_attack[i],
            "angleFromVertical": result.angle_from_vertical[i],
            "stabilityMarginRocketpy": result.stability_margin_rocketpy[i],
            "stabilityMarginOurs": result.stability_margin_ours[i],
            "driftX": result.drift_x[i],
            "driftY": result.drift_y[i],
            "bendingMoment": result.bending_moment[i],
            "omegaPitch": result.omega_pitch[i],
        }
        for i in range(len(result.times))
    ]
    return {
        "motor": {"name": motor_block["name"], "format": motor_block["format"]},
        "samples": samples,
        "fft": {"frequency": result.fft_frequency, "amplitude": result.fft_amplitude},
        "apogee": result.apogee,
        "apogeeTime": result.apogee_time,
        "maxSpeed": result.max_speed,
        "maxMach": result.max_mach,
        "maxAcceleration": result.max_acceleration,
        "maxDynamicPressure": result.max_dynamic_pressure,
        "maxDynamicPressureTime": result.max_dynamic_pressure_time,
        "outOfRailVelocity": result.out_of_rail_velocity,
        "outOfRailStabilityMargin": result.out_of_rail_stability_margin,
        "minStabilityMargin": result.min_stability_margin,
        "minStabilityMarginTime": result.min_stability_margin_time,
        "minStabilityMarginOurs": result.min_stability_margin_ours,
        "maxAngleOfAttack": result.max_angle_of_attack,
        "maxBendingMoment": result.max_bending_moment,
        "driftDistance": result.drift_distance,
        "driftBearing": result.drift_bearing,
        "launchStable": result.launch_stable,
        "approximations": result.approximations,
    }


def _resolve_motor(selection: "MotorSelection | None"):
    """Turn a MotorSelection into a MotorPlacement (for the CG) plus a response block.

    Returns ``(None, None)`` when no motor is selected. Raises 404 if the motor id is not in
    the mirror (e.g. the catalog has not been fetched yet).
    """
    if selection is None:
        return None, None
    motor = _motor_db.get_motor(selection.motorId, selection.simfileId)
    if motor is None:
        raise HTTPException(
            status_code=404,
            detail=f"unknown motor {selection.motorId} (has the catalog been fetched?)",
        )
    dry = selection.state == "burnout"
    mass = motor.burnout_mass if dry else motor.launch_mass
    cmx = motor.burnout_cgx if dry else motor.launch_cgx
    ref_face = (
        (selection.refFace.key, selection.refFace.faceId) if selection.refFace else None
    )
    placement = MotorPlacement(
        mass=mass,
        length=motor.length,
        cmx=cmx,
        diameter=motor.diameter,
        aft_offset=selection.aftOffset,
        ref_face=ref_face,
    )
    name = f"{motor.manufacturer} {motor.designation}".strip()
    block = {
        "motorId": selection.motorId,
        "simfileId": motor.simfile_id,
        "name": name,
        "quality": motor.quality,
        "format": motor.file_format,
        "state": selection.state,
        "wetMass": motor.launch_mass,
        "dryMass": motor.burnout_mass,
        "propMass": motor.propellant_mass,
        "length": motor.length,
        "diameter": motor.diameter,
        "burnTime": motor.burn_time,
    }
    return placement, block


# -- Motor catalog (global, mirrored from thrustcurve.org) --------------------


@app.get("/api/motors")
async def search_motors(
    query: str = Query("", max_length=100),
    impulseClass: str = Query("", max_length=2),
    model: str = Query("", max_length=8),
    limit: int = Query(60, ge=1, le=500),
):
    """Search the offline motor mirror by manufacturer / designation / common name.

    ``impulseClass`` filters to one class exactly (A..O). ``model`` filters by tier: "full"
    (has a RockSim datafile) or "basic" (RASP only). ``total`` is the full match count before
    the ``limit`` slice, so the UI can say "showing N of M".
    """
    cls = impulseClass or None
    tier = model or None
    return {
        "items": _motor_db.search(query, impulse_class=cls, model=tier, limit=limit),
        "total": _motor_db.count(query, impulse_class=cls, model=tier),
        "fetchedAt": _motor_db.fetched_at,
        "available": _motor_db.exists(),
    }


@app.get("/api/motors/{motor_id}")
async def get_motor(motor_id: str):
    """Full detail for one motor: metadata plus every datafile (Full/Basic) and its curve."""
    meta = _motor_db.get_meta(motor_id)
    simfiles = _motor_db.get_simfiles(motor_id)
    if meta is None and not simfiles:
        raise HTTPException(status_code=404, detail=f"unknown motor {motor_id}")
    return {
        "meta": meta,
        "simfiles": [
            {
                "simfileId": s.simfile_id,
                "format": s.file_format,
                "quality": s.quality,
                "designation": s.designation,
                "manufacturer": s.manufacturer,
                "length": s.length,
                "diameter": s.diameter,
                "wetMass": s.launch_mass,
                "dryMass": s.burnout_mass,
                "propMass": s.propellant_mass,
                "burnTime": s.burn_time,
                "time": s.time,
                "thrust": s.thrust,
                "cgX": s.cg_x,
                "mass": s.mass,
            }
            for s in simfiles
        ],
    }


# -- Onshape browsing ---------------------------------------------------------
#
# Two calls are enough to pick a model, which is why the picker searches rather
# than enumerating: this account has 600+ documents and /documents caps its page
# size at 20 (limit=21 is a 400), so listing everything would be 30+ requests
# before the user has typed anything, and it would still need one call per
# document to discover which of its tabs are assemblies.
#
# Both endpoints below are cache-first and only reach Onshape when `refresh=1`
# says the user asked for it. See browse.py for why there is no TTL: browsing
# used to be the app's biggest consumer of API quota despite producing nothing.

#: Onshape's own cap. Sending more is rejected outright rather than clamped.
DOCUMENT_PAGE_LIMIT = 20


def _onshape_error(exc: Exception) -> HTTPException:
    if isinstance(exc, MissingCredentials):
        # 503, not 500: the server is fine, it just has not been given keys.
        return HTTPException(status_code=503, detail=str(exc))
    return HTTPException(status_code=502, detail=str(exc))


@app.get("/api/onshape/documents")
async def search_documents(
    q: str = Query("", description="Name search; empty lists everything cached."),
    limit: int = Query(DOCUMENT_PAGE_LIMIT, ge=1, le=DOCUMENT_PAGE_LIMIT),
    refresh: bool = Query(False, description="Ask Onshape. Costs one API call."),
):
    """Documents these credentials own (Onshape `filter=0`).

    Without `refresh` this issues no API call at all: it replays a previous
    answer to the same query, or falls back to a name match over everything
    cached. With `refresh`, one call goes to Onshape and the result is merged
    into that index and remembered against `q`. See browse.py.

    Onshape's own results are ranked rather than alphabetical, so a short query
    can push an exact match down the list -- which is why the page limit is sent
    at its maximum rather than something smaller and tidier.
    """
    if not refresh:
        return _browse.search_documents(q)

    params: dict[str, Any] = {"filter": 0, "limit": limit}
    if q.strip():
        params["q"] = q.strip()

    # cache_dir=None: the client's disk cache is keyed by request and never
    # expires, which is right for immutable microversion reads and wrong here --
    # it would make an explicit refresh return the same answer forever.
    try:
        with OnshapeClient(cache_dir=None) as client:
            payload = client.get_json("/documents", params)
    except (OnshapeError, MissingCredentials) as exc:
        raise _onshape_error(exc) from exc

    documents = []
    for item in payload.get("items", []) if isinstance(payload, dict) else []:
        workspace = item.get("defaultWorkspace") or {}
        if not workspace.get("id"):
            continue
        documents.append(
            {
                "documentId": item.get("id"),
                "name": item.get("name"),
                "workspaceId": workspace.get("id"),
                "owner": (item.get("owner") or {}).get("name"),
                "modifiedAt": item.get("modifiedAt"),
            }
        )
    return _browse.store_documents(documents, q)


@app.get("/api/onshape/documents/{document_id}/w/{workspace_id}/assemblies")
async def list_assemblies(
    document_id: str,
    workspace_id: str,
    refresh: bool = Query(False, description="Ask Onshape. Costs one API call."),
):
    """The assembly tabs of one document, which is what can actually be built.

    Cached after the first look. Assembly tabs are added and renamed far less
    often than a picker gets opened, so a repeat visit should be free.
    """
    if not refresh:
        cached = _browse.get_assemblies(document_id, workspace_id)
        if cached is not None:
            return cached
        # Never expanded before, so there is nothing to serve and no way to get
        # it except from Onshape. Fall through and spend the one call.

    try:
        with OnshapeClient(cache_dir=None) as client:
            elements = client.get_json(
                f"/documents/d/{document_id}/w/{workspace_id}/elements",
                {"elementType": "ASSEMBLY"},
            )
    except (OnshapeError, MissingCredentials) as exc:
        raise _onshape_error(exc) from exc

    assemblies = [
        {"elementId": element.get("id"), "name": element.get("name")}
        for element in (elements if isinstance(elements, list) else [])
        if element.get("id")
    ]
    return _browse.store_assemblies(document_id, workspace_id, assemblies)


# -- Builds -------------------------------------------------------------------


class BuildRequest(BaseModel):
    """Either a pasted URL, or the three ids the picker already resolved."""

    url: str | None = None
    documentId: str | None = None
    workspaceId: str | None = None
    elementId: str | None = None


#: Build jobs, keyed by id. In-memory on purpose -- a job is meaningless across
#: a restart, since the artifact it produces is discovered from the cache anyway.
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()

#: One at a time. Builds are network- and CPU-heavy and share the disk cache,
#: and two concurrent builds of the same ref would race on the same files.
_build_lock = threading.Lock()


def _job_update(job_id: str, **fields: Any) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is not None:
            job.update(fields)


def _run_job(job_id: str, url: str) -> None:
    def progress(message: str) -> None:
        with _jobs_lock:
            job = _jobs.get(job_id)
            if job is not None:
                job["log"].append(message)
                job["message"] = message

    if not _build_lock.acquire(blocking=False):
        _job_update(job_id, status="error", message="Another build is already running.")
        return
    try:
        _job_update(job_id, status="running", message="Starting…")
        manifest = run_build(url, on_progress=progress)
        _job_update(
            job_id,
            status="done",
            modelId=manifest.get("source", {}).get("modelId"),
            message="Build complete.",
        )
    except (OnshapeError, MissingCredentials) as exc:
        _job_update(job_id, status="error", message=str(exc))
    except Exception as exc:  # noqa: BLE001 - surfaced to the client verbatim
        _job_update(job_id, status="error", message=f"{type(exc).__name__}: {exc}")
    finally:
        _build_lock.release()


@app.post("/api/build")
async def start_build(request: BuildRequest):
    """Kick off a build and return a job id to poll."""
    if request.url and request.url.strip():
        url = request.url.strip()
    elif request.documentId and request.workspaceId and request.elementId:
        base = OnshapeClient().base_url.removesuffix("/api/v12").removesuffix("/api")
        url = (
            f"{base}/documents/{request.documentId}"
            f"/w/{request.workspaceId}/e/{request.elementId}"
        )
    else:
        raise HTTPException(
            status_code=400,
            detail="Provide either a url, or documentId + workspaceId + elementId.",
        )

    job_id = uuid.uuid4().hex
    with _jobs_lock:
        _jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "message": "Queued.",
            "log": [],
            "url": url,
            "modelId": None,
            "startedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }

    threading.Thread(target=_run_job, args=(job_id, url), daemon=True).start()
    return {"jobId": job_id, "status": "queued"}


@app.get("/api/build/{job_id}")
async def build_status(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="unknown build job")
        return dict(job)
