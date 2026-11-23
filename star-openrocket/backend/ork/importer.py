"""Write an .ork into ``cache/`` as a model, with the same three artifacts a build writes.

The GLB, the geometry sidecar and the manifest come out of the build's own writers
(``_write_glb``, ``write_geometry``, ``_build_manifest``), fed with records made from
the .ork instead of from Onshape, so the viewer and every analysis endpoint read an
imported rocket exactly as they read a CAD one. What only an .ork has -- its motors,
OpenRocket's own simulation results, the shapes it was drawn with -- goes under
``manifest["ork"]``.

The model id is ``ork_`` plus a hash of the file, so importing the same file twice
gives the same model, and an edited file a new one.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path

import numpy as np

from ..motors.db import MotorDB
from ..onshape import build as build_mod
from ..onshape.assembly import AssemblyWalk, Occurrence, SourceKey, occurrence_key
from ..onshape.geometry import inertia_per_unit_mass
from ..onshape.geometry_store import write_geometry
from ..onshape.mass import AssemblyTotals, MassOverrides
from ..onshape.mass import Material as MassMaterial
from ..onshape.urls import ResolvedRef
from .document import OrkDocument, OrkMotor, parse_ork
from .mesh import component_mesh

_IDENTITY = np.eye(4).flatten().tolist()


def model_id_for(data: bytes) -> str:
    return "ork_" + hashlib.sha256(data).hexdigest()[:16]


def import_ork(data: bytes, filename: str, cache_root: Path, motor_db: MotorDB | None = None) -> dict:
    """Parse ``data`` and write it as a model under ``cache_root``. Returns the manifest."""
    started = time.time()
    doc = parse_ork(data)
    model_id = model_id_for(data)
    model_dir = cache_root / model_id
    model_dir.mkdir(parents=True, exist_ok=True)
    digest = model_id.removeprefix("ork_")

    report = build_mod.BuildReport()
    for warning in doc.warnings:
        report.warn(warning)

    parts: list[build_mod.PartRecord] = []
    sources: dict[SourceKey, build_mod.SourceData] = {}
    occurrences: list[Occurrence] = []
    for comp in doc.components:
        source = SourceKey(document_id=f"ork:{digest}", microversion_id=digest, element_id=comp.id, configuration="default")
        path = [comp.id]
        occ = Occurrence(
            key=occurrence_key(path), part_id="ork", instance_id=comp.id, path=path, name=comp.name,
            source=source, transform=_IDENTITY, is_standard_content=False, hidden=False,
        )
        occurrences.append(occ)
        built = component_mesh(comp)
        mesh, surfaces = built if built is not None else (None, {})
        sources[source] = build_mod.SourceData(
            source=source, bodies={}, materials={}, part_names={"ork": comp.name},
            overrides=MassOverrides({}, {}), meshes={"ork": mesh} if mesh else {},
            surfaces={"ork": surfaces} if mesh else {},
        )
        volume, inertia = 0.0, None
        if mesh is not None:
            from ..onshape.geometry import volume_and_centroid

            volume = abs(volume_and_centroid(mesh.vertices, mesh.indices)[0])
            tensor = inertia_per_unit_mass(mesh.vertices, mesh.indices)
            if tensor is not None and build_mod._physical(tensor):
                inertia = tensor.flatten().tolist()
        centroid = [0.0, 0.0, -comp.cg]  # on the axis, z = -x
        material = comp.material
        parts.append(
            build_mod.PartRecord(
                occurrence=occ,
                part_name=comp.name,
                mass=comp.mass,
                volume=volume,
                centroid_local=centroid,
                centroid_world=centroid,
                material=MassMaterial(material.name, material.density) if material and material.kind == "bulk" else None,
                material_defaulted=False,
                has_geometry=mesh is not None,
                inertia_per_kg_world=inertia,
                mass_overridden=comp.mass_overridden,
            )
        )

    build_mod._write_glb(parts, sources, model_dir / "model.glb", False, report)
    write_geometry(model_dir, parts, sources)

    total = sum(p.mass for p in parts)
    centroid = build_mod._weighted_centroid(parts)
    ref = ResolvedRef(f"ork:{digest}", "rocket", "m", digest, "ork-import", microversion_id=digest)
    walk = AssemblyWalk(
        root_microversion=digest, assembly_name=filename, occurrences=occurrences,
        sources=list(sources), subassembly_count=0, total_occurrences=len(occurrences), warnings=[],
    )
    # The .ork is its own ground truth: the totals are the components' sum by construction.
    totals = AssemblyTotals(mass=total, centroid=centroid, has_mass=True, mass_missing_count=0)
    manifest = build_mod._build_manifest(
        ref=ref, walk=walk, parts=parts, totals=totals, document_name=doc.rocket_name,
        report=report, elapsed=time.time() - started, stats={"apiCalls": 0, "cacheHits": 0, "retries": 0},
    )
    manifest["source"]["kind"] = "ork"
    manifest["source"]["fileName"] = filename
    manifest["source"]["modelId"] = model_id
    manifest["source"].pop("apiVersion", None)
    manifest["ork"] = _ork_block(doc, motor_db)

    (model_dir / "source.ork").write_bytes(data)
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def _ork_block(doc: OrkDocument, motor_db: MotorDB | None) -> dict:
    return {
        "rocketName": doc.rocket_name,
        "length": doc.length,
        "referenceDiameter": 2 * doc.reference_radius,
        "mass": doc.mass,
        "cgFromNose": doc.cg,
        "motors": [_motor_block(m, doc.length, motor_db) for m in doc.motors],
        "simulations": doc.simulations,
        "drag": doc.drag,
        "components": [
            {"id": c.id, "name": c.name, "type": c.tag, "x": c.x, "length": c.length,
             "mass": c.mass, "cg": c.cg, "massOverridden": c.mass_overridden, "depth": c.depth}
            for c in doc.components
        ],
    }


def _motor_block(motor: OrkMotor, airframe_length: float, motor_db: MotorDB | None) -> dict:
    match = match_motor(motor, motor_db) if motor_db is not None else None
    return {
        "configId": motor.config_id,
        "default": motor.default,
        "manufacturer": motor.manufacturer,
        "designation": motor.designation,
        "digest": motor.digest,
        "diameter": motor.diameter,
        "length": motor.length,
        "mount": motor.mount,
        "aftFromNose": motor.aft_x,
        # The app's MotorSelection.aftOffset: aft end relative to the airframe's aft
        # end, aft-positive (an .ork overhang past a boattail is negative here).
        "aftOffset": motor.aft_x - airframe_length,
        "motorId": match["motorId"] if match else None,
        "simfileId": match["simfileId"] if match else None,
        "matchedBy": match["matchedBy"] if match else None,
    }


_COMMON = re.compile(r"([A-Za-z])(\d+(?:\.\d+)?)")


def common_name(designation: str) -> str | None:
    """OpenRocket's ``17631N3800-P`` / ``O5500X-PS`` -> thrustcurve's ``N3800`` / ``O5500``."""
    stripped = re.sub(r"^\d+", "", designation.strip())
    m = _COMMON.match(stripped)
    return f"{m.group(1).upper()}{m.group(2)}" if m else None


def _manufacturer_matches(ork_name: str, meta: dict) -> bool:
    a = ork_name.lower()
    names = [str(meta.get("manufacturer") or "").lower(), str(meta.get("manufacturerAbbrev") or "").lower()]
    return any(n and (n in a or a in n or n.split()[0] == a.split()[0]) for n in names if a)


def match_motor(motor: OrkMotor, db: MotorDB) -> dict | None:
    """The thrustcurve.org motor an .ork motor names.

    OpenRocket identifies a motor by the digest of its thrust data; the offline
    catalogue's index does not carry digests, so candidates are found by maker,
    common name and diameter, and the digest confirms one when its data file is
    cached. ``matchedBy`` says which it was.
    """
    common = common_name(motor.designation)
    if common is None:
        return None
    candidates = [
        m for m in db.all_meta()
        if str(m.get("commonName", "")).upper() == common
        and abs(float(m.get("diameter") or 0) - motor.diameter * 1000) < 1.0
        and _manufacturer_matches(motor.manufacturer, m)
    ]
    for meta in candidates:
        for simfile in db.get_simfiles(meta["motorId"]):
            if motor.digest and simfile.digest == motor.digest:
                return {"motorId": meta["motorId"], "simfileId": simfile.simfile_id, "matchedBy": "digest"}
    if len(candidates) == 1:
        return {"motorId": candidates[0]["motorId"], "simfileId": None, "matchedBy": "designation"}
    # Several fit by name (propellant variants): prefer one whose designation shares
    # the .ork's propellant suffix.
    suffix = motor.designation.split("-")[-1].upper() if "-" in motor.designation else ""
    for meta in candidates:
        if suffix and str(meta.get("designation", "")).upper().endswith(suffix):
            return {"motorId": meta["motorId"], "simfileId": None, "matchedBy": "designation"}
    return None
