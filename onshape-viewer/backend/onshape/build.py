"""Build orchestrator: Onshape assembly URL -> model.glb + manifest.json.

This is the expensive, cached half of the split described in orkv2.md 3.2. It
runs offline as a CLI; the browser only ever consumes its two output files, which
is also why no credential can reach the browser -- there is no code path from one
to the other.

    python -m backend.onshape.build <onshape-url>

Output lands in ``cache/<documentId>_<wvmId>/`` and is keyed on an immutable ref,
so a second run of the same ref issues zero API calls.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import mass as mass_mod
from .assembly import AssemblyWalk, Occurrence, SourceKey, walk_assembly
from .client import OnshapeClient, OnshapeError
from .geometry import transform_point, volume_and_centroid
from .glb import GLBBuilder, MeshKey
from .mass import DEFAULT_DENSITY, AssemblyTotals, BodyMass, Material
from .tessellate import PartMesh, fetch_source_meshes
from .urls import ResolvedRef, parse_document_url, resolve

SCHEMA_VERSION = 1
CACHE_ROOT = Path(__file__).resolve().parents[2] / "cache"

# Relative tolerance for reconciling the per-part sum against the assembly total.
RECONCILE_TOLERANCE = 1e-6


@dataclass
class SourceData:
    """Everything fetched for one Part Studio."""

    source: SourceKey
    bodies: dict[str, BodyMass]
    materials: dict[str, Material]
    meshes: dict[str, PartMesh]


@dataclass
class PartRecord:
    """One occurrence, fully resolved: geometry, mass, and world-frame centroid."""

    occurrence: Occurrence
    mass: float
    volume: float
    centroid_local: list[float]
    centroid_world: list[float]
    material: Material | None
    material_defaulted: bool
    has_geometry: bool


@dataclass
class BuildReport:
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def warn(self, message: str) -> None:
        self.warnings.append(message)


def build(
    url: str,
    output_dir: Path | None = None,
    default_density: float = DEFAULT_DENSITY,
    emit_gltf: bool = False,
    offline: bool = False,
) -> dict:
    """Run the full build and return the manifest dict."""
    started = time.time()
    report = BuildReport()

    ref_in = parse_document_url(url)
    cache_dir = (output_dir or CACHE_ROOT / f"{ref_in.document_id}_{ref_in.wvm_id}")
    raw_dir = cache_dir / "raw"

    with OnshapeClient(cache_dir=raw_dir, offline=offline) as client:
        # Note: document info is /documents/{did} with no /d/ segment, unlike
        # every other endpoint here (and unlike orkv2.md 9, which lists /d/).
        document = client.get_json(f"/documents/{ref_in.document_id}")
        print(f"Document: {document.get('name')}")

        ref = resolve(client, ref_in)
        report.warnings.extend(ref.warnings)
        print(f"Building against {ref.wvm}/{ref.wvm_id} ({ref.resolved_from})")

        walk = walk_assembly(client, ref)
        report.warnings.extend(walk.warnings)
        print(
            f"Assembly: {len(walk.occurrences)} parts from {walk.total_occurrences} occurrences, "
            f"{walk.subassembly_count} subassemblies, {len(walk.sources)} tessellation targets"
        )
        if not walk.occurrences:
            raise OnshapeError(
                "The assembly resolved to zero parts. Check the element id points at an "
                "assembly tab with geometry in it."
            )

        totals = mass_mod.fetch_assembly_totals(client, ref.element_path)
        print(f"Assembly mass (ground truth): {totals.mass:.6f} kg, {totals.mass_missing_count} parts without mass")

        sources = _fetch_sources(client, walk, ref.document_id, report)

    parts = _resolve_parts(walk, sources, default_density, report)
    glb_path = cache_dir / "model.glb"
    _write_glb(parts, sources, glb_path, emit_gltf, report)

    manifest = _build_manifest(
        ref=ref,
        walk=walk,
        parts=parts,
        totals=totals,
        document_name=document.get("name", ""),
        default_density=default_density,
        report=report,
        elapsed=time.time() - started,
        stats=client.stats(),
    )

    manifest_path = cache_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))

    _print_report(manifest, glb_path, manifest_path)
    return manifest


def _fetch_sources(
    client: OnshapeClient, walk: AssemblyWalk, root_document_id: str, report: BuildReport
) -> dict[SourceKey, SourceData]:
    """Fetch mass, materials and geometry for every distinct Part Studio."""

    def fetch(source: SourceKey) -> SourceData:
        # Required whenever the part lives in a different document from the
        # assembly; harmless when it does not (orkv2.md 7.5).
        link = root_document_id if source.document_id != root_document_id else None
        try:
            bodies = mass_mod.fetch_source_bodies(client, source, link)
        except OnshapeError as exc:
            report.warn(f"Mass properties failed for {source.element_id}: {exc}")
            bodies = {}
        try:
            materials = mass_mod.fetch_source_materials(client, source, link)
        except OnshapeError as exc:
            report.warn(f"Materials failed for {source.element_id}: {exc}")
            materials = {}
        try:
            meshes = fetch_source_meshes(client, source, link)
        except OnshapeError as exc:
            report.warn(f"Tessellation failed for {source.element_id}: {exc}")
            meshes = {}
        return SourceData(source, bodies, materials, meshes)

    results = client.map_parallel(fetch, walk.sources)
    return {data.source: data for data in results}


def _resolve_parts(
    walk: AssemblyWalk,
    sources: dict[SourceKey, SourceData],
    default_density: float,
    report: BuildReport,
) -> list[PartRecord]:
    """Join geometry and mass per occurrence, defaulting density where needed."""
    records: list[PartRecord] = []

    for occ in walk.occurrences:
        data = sources.get(occ.source)
        if data is None:
            report.warn(f"{occ.name}: no data fetched for its Part Studio; skipped.")
            continue

        body = data.bodies.get(occ.part_id)
        mesh = data.meshes.get(occ.part_id)
        material = data.materials.get(occ.part_id)

        if body is None:
            report.warn(f"{occ.name} ({occ.part_id}): no mass properties returned; skipped.")
            continue
        if mesh is None:
            report.warn(f"{occ.name} ({occ.part_id}): has mass but no geometry.")

        volume = body.volume
        defaulted = not body.has_mass

        if defaulted:
            # Onshape zeroes both the mass and the centroid for a part with no
            # material. Volume survives and is exact, so mass is recovered from
            # volume x assumed density; the centroid has to be integrated from
            # the mesh because there is no other source for it.
            part_mass = volume * default_density
            centroid_local = _mesh_centroid(mesh, occ, volume, report)
        else:
            part_mass = body.mass
            centroid_local = list(body.centroid)

        records.append(
            PartRecord(
                occurrence=occ,
                mass=part_mass,
                volume=volume,
                centroid_local=centroid_local,
                # Precomputed at build time so the runtime centre of mass is a
                # plain weighted sum (orkv2.md 6, Phase 6).
                centroid_world=transform_point(centroid_local, occ.transform).tolist(),
                material=material,
                material_defaulted=defaulted,
                has_geometry=mesh is not None,
            )
        )

    return records


def _mesh_centroid(
    mesh: PartMesh | None, occ: Occurrence, api_volume: float, report: BuildReport
) -> list[float]:
    """Volume centroid from the tessellation, with a sanity check against the API."""
    if mesh is None:
        report.warn(
            f"{occ.name}: no material and no geometry, so its centroid is unknown; "
            "placed at the Part Studio origin."
        )
        return [0.0, 0.0, 0.0]

    mesh_volume, centroid = volume_and_centroid(mesh.vertices, mesh.indices)
    mesh_volume = abs(mesh_volume)

    # A large disagreement means the tessellation is not closed, which makes the
    # centroid unreliable rather than merely imprecise.
    if api_volume > 0 and mesh_volume > 0:
        error = abs(mesh_volume - api_volume) / api_volume
        if error > 0.02:
            report.warn(
                f"{occ.name}: mesh volume differs from the API volume by {error:.1%} "
                f"({mesh_volume:.3e} vs {api_volume:.3e} m^3); its defaulted centroid may be off."
            )
    return centroid.tolist()


def _write_glb(
    parts: list[PartRecord],
    sources: dict[SourceKey, SourceData],
    path: Path,
    emit_gltf: bool,
    report: BuildReport,
) -> None:
    builder = GLBBuilder()

    for record in parts:
        occ = record.occurrence
        mesh = sources[occ.source].meshes.get(occ.part_id)
        if mesh is None:
            continue
        key = MeshKey(occ.source.element_id, occ.part_id, occ.source.configuration)
        builder.add_occurrence(occ, builder.add_mesh(key, mesh, occ.name))

    if not builder.has_geometry():
        raise OnshapeError("No geometry was tessellated; refusing to write an empty GLB.")

    builder.save(path, also_gltf=emit_gltf)
    stats = builder.stats()
    print(
        f"GLB: {stats['meshes']} unique meshes, {stats['nodes']} nodes, "
        f"{stats['bufferBytes'] / 1e6:.2f} MB of buffer"
    )


def _weighted_centroid(records: list[PartRecord]) -> list[float]:
    total = sum(r.mass for r in records)
    if total <= 0:
        return [0.0, 0.0, 0.0]
    acc = np.zeros(3)
    for record in records:
        acc += np.asarray(record.centroid_world) * record.mass
    return (acc / total).tolist()


def _build_manifest(
    ref: ResolvedRef,
    walk: AssemblyWalk,
    parts: list[PartRecord],
    totals: AssemblyTotals,
    document_name: str,
    default_density: float,
    report: BuildReport,
    elapsed: float,
    stats: dict,
) -> dict:
    measured = [p for p in parts if not p.material_defaulted]
    defaulted = [p for p in parts if p.material_defaulted]

    mass_measured = sum(p.mass for p in measured)
    mass_defaulted = sum(p.mass for p in defaulted)

    # The assembly total excludes materialless parts, so only the measured
    # subset is comparable to it. Including the defaulted mass here would
    # guarantee a mismatch and make the check meaningless.
    delta = abs(mass_measured - totals.mass)
    relative = delta / totals.mass if totals.mass else 0.0
    if relative > RECONCILE_TOLERANCE:
        report.warn(
            f"Mass reconciliation FAILED: measured parts sum to {mass_measured:.6f} kg but the "
            f"assembly reports {totals.mass:.6f} kg (relative error {relative:.2e}). "
            "Parts have probably been dropped from the walk."
        )

    if defaulted:
        report.warn(
            f"{len(defaulted)} of {len(parts)} parts have no material assigned in Onshape. "
            f"Their mass is estimated as volume x {default_density:.0f} kg/m^3 and their "
            "centroid is integrated from the mesh. These are assumptions, not measurements."
        )

    return {
        "schemaVersion": SCHEMA_VERSION,
        "source": {
            "documentId": ref.document_id,
            "documentName": document_name,
            "elementId": ref.element_id,
            "versionId": ref.version_id,
            "microversionId": ref.microversion_id or walk.root_microversion,
            "resolvedFrom": ref.resolved_from,
            "assemblyName": walk.assembly_name,
            "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "apiVersion": os.environ.get("ONSHAPE_BASE_URL", "").rsplit("/", 1)[-1] or "v12",
        },
        # Declared so the viewer knows the axis swap is already baked into the
        # GLB and must not be applied again.
        "upAxisHandling": "glb-root",
        "defaultDensity": default_density,
        "totals": {
            "mass": mass_measured + mass_defaulted,
            "massMeasured": mass_measured,
            "massDefaulted": mass_defaulted,
            "assemblyMass": totals.mass,
            "centroid": _weighted_centroid(parts),
            "centroidMeasured": _weighted_centroid(measured),
            "assemblyCentroid": totals.centroid,
            "partCount": len(parts),
            "partsWithoutMaterial": len(defaulted),
            "reconciliationDelta": delta,
            "reconciliationRelative": relative,
            "reconciled": relative <= RECONCILE_TOLERANCE,
        },
        "parts": [
            {
                "key": p.occurrence.key,
                "partId": p.occurrence.part_id,
                "instanceId": p.occurrence.instance_id,
                "occurrencePath": p.occurrence.path,
                "name": p.occurrence.name,
                "sourceDocumentId": p.occurrence.source.document_id,
                "sourceElementId": p.occurrence.source.element_id,
                "configuration": p.occurrence.source.configuration,
                "isStandardContent": p.occurrence.is_standard_content,
                "hidden": p.occurrence.hidden,
                "material": (
                    {"name": p.material.name, "density": p.material.density} if p.material else None
                ),
                "materialDefaulted": p.material_defaulted,
                "mass": p.mass,
                "volume": p.volume,
                "centroidLocal": p.centroid_local,
                "centroidWorld": p.centroid_world,
                "transform": p.occurrence.transform,
                "hasGeometry": p.has_geometry,
            }
            for p in parts
        ],
        "build": {
            "elapsedSeconds": round(elapsed, 2),
            **stats,
        },
        "warnings": report.warnings,
    }


def _print_report(manifest: dict, glb_path: Path, manifest_path: Path) -> None:
    totals = manifest["totals"]
    build_stats = manifest["build"]
    print()
    print("=== Build report ===")
    print(f"  parts               : {totals['partCount']}")
    print(f"  measured mass       : {totals['massMeasured']:.6f} kg  ({totals['partCount'] - totals['partsWithoutMaterial']} parts)")
    print(f"  defaulted mass      : {totals['massDefaulted']:.6f} kg  ({totals['partsWithoutMaterial']} parts)")
    print(f"  assembly ground truth: {totals['assemblyMass']:.6f} kg")
    status = "OK" if totals["reconciled"] else "FAILED"
    print(f"  reconciliation      : {status} (relative {totals['reconciliationRelative']:.2e})")
    print(f"  centre of mass      : {[round(x, 6) for x in totals['centroid']]} m")
    print(f"  API calls           : {build_stats['apiCalls']} (cache hits {build_stats['cacheHits']}, retries {build_stats['retries']})")
    print(f"  elapsed             : {build_stats['elapsedSeconds']} s")
    if manifest["warnings"]:
        print(f"  warnings            : {len(manifest['warnings'])}")
        for warning in manifest["warnings"]:
            print(f"    - {warning}")
    print()
    print(f"  wrote {glb_path}")
    print(f"  wrote {manifest_path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build model.glb + manifest.json from an Onshape assembly URL."
    )
    parser.add_argument("url", help="Onshape assembly URL")
    parser.add_argument("--output-dir", type=Path, default=None, help="override the cache directory")
    parser.add_argument(
        "--default-density",
        type=float,
        default=DEFAULT_DENSITY,
        help=f"kg/m^3 assumed for parts with no material (default {DEFAULT_DENSITY:.0f})",
    )
    parser.add_argument("--gltf", action="store_true", help="also emit readable .gltf")
    parser.add_argument(
        "--offline", action="store_true", help="serve entirely from cache; fail if anything is missing"
    )
    args = parser.parse_args(argv)

    try:
        manifest = build(
            args.url,
            output_dir=args.output_dir,
            default_density=args.default_density,
            emit_gltf=args.gltf,
            offline=args.offline,
        )
    except OnshapeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    return 0 if manifest["totals"]["reconciled"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
