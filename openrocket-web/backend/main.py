"""openrocket-web API: docs/SCHEMA.md's routes over the orweb port of OpenRocket 24.12.

Stateless: every request carries the whole document, and the analysis is rebuilt
from it. A design is a few dozen components, the build plus the Barrowman pass
takes a few milliseconds, and nothing can go stale between requests.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from orweb import (OPENROCKET_VERSION, build_rocket, configuration_for, default_component, default_registry,
                   document_from_json, mass_properties, materials_listing, model_params, read_ork, side_figure,
                   write_ork)
from orweb.aero import analyze as aero_analyze

ROOT = Path(__file__).resolve().parent.parent
EXAMPLES = ROOT / "tests" / "rockets"

app = FastAPI(title="openrocket-web", description="OpenRocket 24.12's design view, ported to Python.")


class Conditions(BaseModel):
    mach: float = 0.3
    aoaDeg: float = 0.0
    rollRate: float = 0.0
    theta: float = 0.0
    configId: str | None = None


class AnalyzeRequest(BaseModel):
    document: dict[str, Any]
    conditions: Conditions = Conditions()


def _finite(v):
    """JSON has no NaN/Infinity: an absent number goes on the wire as null."""
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _finite(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_finite(x) for x in v]
    return v


def _bad(e: Exception) -> HTTPException:
    return HTTPException(status_code=422, detail=f"{type(e).__name__}: {e}")


@app.get("/api/health")
def health():
    return {"ok": True, "openrocket": OPENROCKET_VERSION}


@app.get("/api/examples")
def examples():
    return [{"name": p.stem} for p in sorted(EXAMPLES.glob("*.ork"))]


@app.get("/api/examples/{name}")
def example(name: str):
    path = EXAMPLES / f"{name}.ork"
    if path.parent != EXAMPLES or not path.exists():
        raise HTTPException(404, f"no example {name!r}")
    return _finite(read_ork(path, keep_simulations=True))


@app.post("/api/ork/import")
async def ork_import(file: UploadFile = File(...)):
    try:
        return _finite(read_ork(await file.read(), keep_simulations=True))
    except Exception as e:  # a file we cannot read is the caller's problem, not a 500
        raise _bad(e)


@app.post("/api/ork/export")
def ork_export(document: dict[str, Any] = Body(...)):
    try:
        data = write_ork(document_from_json(document))
    except Exception as e:
        raise _bad(e)
    name = (document.get("rocket", {}).get("name") or "rocket").replace('"', "")
    return Response(data, media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{name}.ork"'})


def _resolved(rocket, doc: dict) -> dict:
    """For every param the document marks auto, the number OpenRocket resolved it to."""
    out: dict[str, dict[str, float]] = {}

    def walk(dc):
        c = rocket.by_id.get(dc["id"])
        autos = [k for k, v in dc.get("params", {}).items() if isinstance(v, dict) and v.get("auto")]
        if c is not None and autos:
            params = model_params(c)
            vals = {}
            for k in autos:
                rv = params.get(k)
                if isinstance(rv, dict) and isinstance(rv.get("value"), (int, float)):
                    vals[k] = rv["value"]
            if vals:
                out[dc["id"]] = vals
        for ch in dc.get("children", []):
            walk(ch)

    walk(doc["rocket"])
    return out


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest):
    try:
        doc = document_from_json(req.document)
        warnings: list[str] = []
        rocket = build_rocket(doc, warnings=warnings)
        config = configuration_for(rocket, req.conditions.configId)
    except Exception as e:
        raise _bad(e)
    c = req.conditions
    mass = mass_properties(rocket, config)
    aero = aero_analyze(config, c.mach, math.radians(c.aoaDeg), c.rollRate, c.theta)
    figure = side_figure(rocket, config)

    ref = aero["reference"]["length"]
    # OpenRocket's figure (RocketPanel.updateExtras) prints the configuration's whole
    # length, but its stability percentage is of the *aerodynamic* length
    # (PercentageOfLengthUnit.getReferenceLength). They differ when something
    # non-aerodynamic hangs past the body, e.g. a motor overhang.
    length_aero = mass["lengthAerodynamic"]
    cg = mass["cg"]
    cp = aero["cp"]
    margin = cp["x"] - cg["x"] if cp["cna"] else float("nan")

    # RocketPanel.updateExtras: the largest fore/aft diameter of the core stages'
    # symmetric components -- not a lug or a fin sticking out of the body.
    max_d = float("nan")
    for comp in config.get_core_components():
        if hasattr(comp, "get_fore_radius") and hasattr(comp, "get_aft_radius"):
            d = 2 * max(comp.get_fore_radius(), comp.get_aft_radius())
            max_d = d if math.isnan(max_d) else max(max_d, d)

    forces = {r["id"]: r for r in aero["components"]}
    components = []
    for row in mass["components"]:
        f = forces.get(row["id"], {})
        components.append({**row, "cpx": f.get("cpx"), "cna": f.get("cna"), "cd": f.get("cd"),
                           "cdFriction": f.get("friction"), "cdPressure": f.get("pressure"),
                           "cdBase": f.get("base")})

    return _finite({
        "conditions": c.model_dump(),
        "reference": aero["reference"],
        "length": config.get_length(),
        "lengthAerodynamic": length_aero,
        "maxDiameter": max_d,
        "cg": cg,
        "cgEmpty": {"x": mass["structure"]["cgx"], "mass": mass["structure"]["mass"]},
        "cp": cp,
        "stability": {"calibers": margin / ref if ref else float("nan"),
                      "percent": 100 * margin / length_aero if length_aero else float("nan")},
        "cd": aero["cd"],
        "components": components,
        "motors": mass["motors"],
        "inertia": {k: mass[k] for k in ("launch", "structure", "burnout", "motor")},
        "figure": figure,
        "resolved": _resolved(rocket, doc),
        "warnings": list(dict.fromkeys(warnings + list(rocket.warnings) + aero["warnings"])),
    })


@app.get("/api/components/defaults/{ctype}")
def defaults(ctype: str):
    try:
        return _finite(default_component(ctype))
    except (KeyError, ValueError) as e:
        raise HTTPException(404, str(e))


@app.get("/api/materials")
def materials():
    return materials_listing()


@app.get("/api/motors/search")
def motors_search(q: str = "", diameter: float | None = None):
    return _finite(default_registry().search(q, diameter))
