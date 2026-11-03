"""A saved design, as the request bodies the app's simulations take.

A design (``OrkConfig`` = ``{cad, recovery}``, the document the header bar saves)
stores what someone *chose* -- "this part is 6061", "this mass is typed in",
"the recovery tab's devices". The simulation endpoints take what the physics
needs -- each part's mass in kg, the recovery ``Config`` in wire form. Until now
only the browser turned one into the other, every time Simulate was pressed, so
nothing but the browser could run a saved design.

This is that conversion on the server. It is the same conversion, not a second
opinion: the browser's copy lives in ``frontend/src/lib/designRequests.ts``, and
both are held to the same cases in ``tests/fixtures/design_requests/``
(``tests/test_design_requests.py`` here, ``designRequests.test.ts`` there), so a
change to one that the other does not make fails a test.

Defaults: the CAD slice is merged onto the viewer's defaults exactly as
``reviveViewerConfig`` does. The recovery slice is *not* filled in: a design the
app saved carries every field (``toStoredConfig``), and a missing one is reported
by name rather than guessed.
"""

from __future__ import annotations

from typing import Any

from physics.devices import airframe_band

#: frontend/src/lib/materials.ts MATERIAL_CATALOG, kg/m^3. Held to the TypeScript
#: by tests/test_design_requests.py, which parses that file.
MATERIAL_DENSITY = {"6061": 2700.0, "5052": 2680.0}

#: frontend/src/types/config.ts defaultViewerConfig / defaultFlightParams.
CAD_DEFAULTS: dict[str, Any] = {
    "modelId": None,
    "overrides": {},
    "outerFaces": [],
    "finFaces": [],
    "finCount": 0,
    "motor": None,
    "railLength": 1.0,
    "hiddenKeys": [],
}
FLIGHT_DEFAULTS: dict[str, Any] = {"inclination": 85.0, "heading": 0.0}

RECOVERY_REQUIRED = ("vehicle", "site", "devices", "sweep", "study")


class DesignError(ValueError):
    """The design cannot be turned into a request; the message says why."""


def _cad(config: dict[str, Any]) -> dict[str, Any]:
    """The CAD slice merged onto its defaults, field by field (reviveViewerConfig)."""
    saved = config.get("cad") if isinstance(config.get("cad"), dict) else {}
    cad = dict(CAD_DEFAULTS)
    if isinstance(saved.get("modelId"), str):
        cad["modelId"] = saved["modelId"]
    if isinstance(saved.get("overrides"), dict):
        cad["overrides"] = saved["overrides"]
    for key in ("outerFaces", "finFaces", "hiddenKeys"):
        if isinstance(saved.get(key), list):
            cad[key] = saved[key]
    for key in ("finCount", "railLength"):
        if isinstance(saved.get(key), (int, float)) and not isinstance(saved.get(key), bool):
            cad[key] = saved[key]
    cad["motor"] = saved.get("motor") if saved.get("motor") is not None else None
    flight = saved.get("flight") if isinstance(saved.get("flight"), dict) else {}
    cad["flight"] = {
        k: flight[k] if isinstance(flight.get(k), (int, float)) and not isinstance(flight.get(k), bool) else v
        for k, v in FLIGHT_DEFAULTS.items()
    }
    return cad


def model_id(config: dict[str, Any]) -> str:
    mid = _cad(config)["modelId"]
    if not mid:
        raise DesignError("the design has no CAD model (cad.modelId is empty)")
    return mid


def part_masses(manifest_parts: list[dict[str, Any]], overrides: dict[str, Any]) -> dict[str, float]:
    """Each part's mass in kg, as the viewer computes it (App.tsx ``parts``).

    A typed-in mass wins over everything; otherwise a catalog material gives
    volume x density; otherwise Onshape's own mass. Every part, hidden or not:
    hiding a part is a view choice and the request has always carried them all.
    """
    out: dict[str, float] = {}
    for part in manifest_parts:
        key = part["key"]
        mass = float(part.get("mass") or 0.0)
        override = overrides.get(key)
        if isinstance(override, dict):
            if override.get("massOverridden"):
                mass = float(override.get("mass") or 0.0)
            elif override.get("material"):
                density = MATERIAL_DENSITY.get(str(override["material"]))
                if density is not None:
                    mass = float(part.get("volume") or 0.0) * density
        out[key] = mass
    return out


def _wire_device(d: dict[str, Any]) -> dict[str, Any]:
    trigger = d.get("trigger") or {}
    return {
        "name": d.get("name"),
        "CdS": d.get("CdS"),
        "D0": d.get("D0"),
        "m_c": d.get("m_c"),
        "j": d.get("j"),
        "n": d.get("n"),
        "Cx": d.get("Cx"),
        "trigger": {"kind": trigger.get("kind"), "value": trigger.get("value")},
        "delay": d.get("delay"),
        "k_eff": d.get("k_eff"),
        "v_rel": d.get("v_rel"),
    }


def recovery_config(config: dict[str, Any]) -> dict[str, Any]:
    """The recovery ``Config`` in wire form (serialise.ts ``toWireConfig``)."""
    ui = config.get("recovery")
    if not isinstance(ui, dict):
        raise DesignError("the design has no recovery slice")
    missing = [k for k in RECOVERY_REQUIRED if k not in ui]
    if missing:
        raise DesignError(f"the design's recovery slice is missing {missing}; open and re-save it in the app")
    v = ui["vehicle"] or {}
    site = ui["site"] or {}
    d_body, l_body = v.get("d_body"), v.get("l_body")
    axial = broadside = None
    if any(p.get("key") == "CdS_body" for p in ui["sweep"]):
        if not isinstance(d_body, (int, float)) or not isinstance(l_body, (int, float)):
            raise DesignError("the airframe sweep needs vehicle.d_body and vehicle.l_body")
        axial, broadside = airframe_band(d_body, l_body)
    return {
        "vehicle": {k: v.get(k) for k in ("m", "h_a", "d_body", "l_body", "z0", "v0", "v_lat", "v_lat_dir")},
        "site": {
            "T_pad": None if site.get("source") == "isa" else site.get("T_pad"),
            "p_pad": None if site.get("source") == "isa" else site.get("p_pad"),
            "lapse": site.get("lapse") if site.get("profile") == "measured" else None,
        },
        "devices": [_wire_device(d) for d in ui["devices"]],
        "sweep": [
            {
                "key": p.get("key"),
                "enabled": p.get("enabled"),
                "low": axial if p.get("key") == "CdS_body" else p.get("min"),
                "high": broadside if p.get("key") == "CdS_body" else p.get("max"),
            }
            for p in ui["sweep"]
        ],
        "study": [
            {k: a.get(k) for k in ("key", "device", "enabled", "mode", "start", "stop", "points", "values", "canopies", "pads")}
            for a in ui["study"]
        ],
        "wind": ui.get("wind"),
    }


def _ascent(config: dict[str, Any], manifest_parts: list[dict[str, Any]]) -> dict[str, Any]:
    cad = _cad(config)
    return {
        "outerFaces": cad["outerFaces"],
        # Nothing picked yet means auto-detect, not "no fins": an empty list is the
        # backend's explicit "this rocket has no fins" (App.tsx, FlightDynamicsTab).
        "finFaces": cad["finFaces"] or None,
        "nFins": cad["finCount"] or None,
        "overrides": part_masses(manifest_parts, cad["overrides"]),
        "motor": cad["motor"],
        "railLength": cad["railLength"],
    }


def stability_request(config: dict[str, Any], manifest_parts: list[dict[str, Any]]) -> dict[str, Any]:
    body = _ascent(config, manifest_parts)
    body.pop("railLength")
    return body


def flight_dynamics_request(config: dict[str, Any], manifest_parts: list[dict[str, Any]]) -> dict[str, Any]:
    """The FlightDynamicsTab ``run()`` body: the ascent plus the shared site and wind."""
    cad = _cad(config)
    wire = recovery_config(config)
    return {
        **_ascent(config, manifest_parts),
        "inclination": cad["flight"]["inclination"],
        "heading": cad["flight"]["heading"],
        "site": wire["site"],
        "wind": wire["wind"],
    }


def ork_request(config: dict[str, Any], manifest_parts: list[dict[str, Any]]) -> dict[str, Any]:
    """App.tsx ``handleExportOrk``: the flight body plus the recovery devices."""
    return {**flight_dynamics_request(config, manifest_parts), "devices": recovery_config(config)["devices"]}


def all_requests(config: dict[str, Any], manifest_parts: list[dict[str, Any]]) -> dict[str, Any]:
    ui = config.get("recovery") if isinstance(config.get("recovery"), dict) else {}
    return {
        "modelId": model_id(config),
        "stability": stability_request(config, manifest_parts),
        "flightDynamics": flight_dynamics_request(config, manifest_parts),
        "ork": ork_request(config, manifest_parts),
        "recovery": recovery_config(config),
        # Which recovery bound the design's tabs read (Drift, Full Flight).
        "airframeBound": "broadside" if ui.get("airframeBound") == "broadside" else "axial",
        # The vehicle numbers the Recovery tab took from the ascent when these were
        # on, as they were when the design was saved -- not re-derived here.
        "recoverySources": ui.get("sources") or {},
    }
