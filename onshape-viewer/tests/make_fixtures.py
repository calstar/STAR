"""Regenerate tests/fixtures/ from a populated cache/ directory.

The fixtures are real Onshape responses, trimmed. They are checked in so the test
suite runs offline and in CI with no credentials, and so the schema surprises
documented in the modules under test stay pinned to actual API output rather than
to someone's recollection of it.

Tessellation responses are 3-16 MB each and the repo fails CI on any file over
5 MB, so those are cut down to a few low-facet bodies.

Responses are identified by their shape rather than by filename: the cache stem
is truncated, and several endpoints share a path prefix.

    python tests/make_fixtures.py [cache-dir]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"
CACHE = Path(__file__).resolve().parents[1] / "cache"

ROOT_DOCUMENT = "dbf4d35d8e9fe37819466f72"
MAIN_PART_STUDIO = "ee2ef2459cdd"

# Bodies small enough to keep whole. The fins (JQD/JRD/JRH) are ~20 facets each
# and are also the parts with no material, which is what the defaulting tests
# need; JoD and JfD are ordinary parts with real materials.
KEEP_BODIES = {"JQD", "JRD", "JRH", "JoD", "JfD"}


def load_all(cache: Path) -> list[tuple[Path, object]]:
    out = []
    for path in sorted(cache.glob("raw/*.json")):
        try:
            out.append((path, json.loads(path.read_text())))
        except json.JSONDecodeError:
            continue
    return out


def is_assembly(payload: object) -> bool:
    return isinstance(payload, dict) and "rootAssembly" in payload


def is_tessellation(payload: object) -> bool:
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("bodies"), list)
        and any("faces" in b for b in payload["bodies"])
    )


def is_massproperties(payload: object) -> bool:
    return isinstance(payload, dict) and isinstance(payload.get("bodies"), dict)


def is_assembly_massproperties(payload: object) -> bool:
    return isinstance(payload, dict) and "mass" in payload and "centroid" in payload


def is_parts_list(payload: object) -> bool:
    return isinstance(payload, list) and bool(payload) and "partId" in payload[0]


def trim_tessellation(payload: dict) -> dict:
    """Keep a few whole bodies at full fidelity, for the schema tests."""
    kept = [b for b in payload.get("bodies", []) if b.get("id") in KEEP_BODIES]
    if not kept:
        kept = sorted(
            payload.get("bodies", []),
            key=lambda b: sum(len(f.get("facets", [])) for f in b.get("faces", [])),
        )[:2]
    return {**payload, "bodies": kept}


# Facets kept per body in the decimated per-source fixtures. Enough to give
# every part a mesh and a non-degenerate centroid; the full model is ~50k
# facets, which is far past the repo's 5 MB file ceiling.
DECIMATE_FACETS = 30


def decimate_tessellation(payload: dict) -> dict:
    """Shrink a tessellation to a wiring fixture.

    Keeps every body -- part coverage is the point -- but only the first few
    facets of each, and drops `normals` and `btType`, neither of which the
    parser reads.

    The result is NOT a faithful surface: meshes are open, so volumes and
    centroids computed from it are not the real ones. Nothing asserts those.
    Geometric accuracy is covered in test_geometry.py against analytic solids,
    which is a better test of it than any captured mesh would be.
    """
    bodies = []
    for body in payload.get("bodies", []):
        faces, budget = [], DECIMATE_FACETS
        for face in body.get("faces", []):
            if budget <= 0:
                break
            facets = [
                {
                    "vertices": [
                        {"x": round(v["x"], 6), "y": round(v["y"], 6), "z": round(v["z"], 6)}
                        for v in facet["vertices"]
                    ]
                }
                for facet in (face.get("facets") or [])[:budget]
            ]
            if facets:
                faces.append({"id": face.get("id"), "facets": facets})
                budget -= len(facets)
        bodies.append({"id": body.get("id"), "name": body.get("name"), "faces": faces})
    return {"bodies": bodies}


def main() -> int:
    cache = Path(sys.argv[1]) if len(sys.argv) > 1 else CACHE
    if not cache.exists():
        raise SystemExit(f"no cache at {cache}; run a build first")

    responses = load_all(cache)
    FIXTURES.mkdir(parents=True, exist_ok=True)

    def pick(predicate, *, name_contains: str = "", populated: bool = False):
        for path, payload in responses:
            if name_contains and name_contains not in path.name:
                continue
            if not predicate(payload):
                continue
            if populated and is_assembly(payload) and not payload["rootAssembly"].get("occurrences"):
                continue
            return payload
        return None

    def write(name: str, payload: object | None, compact: bool = False) -> None:
        if payload is None:
            print(f"  {name}: SKIPPED (not in cache)")
            return
        path = FIXTURES / name
        path.write_text(json.dumps(payload, indent=None if compact else 1))
        print(f"  {name}: {path.stat().st_size / 1024:.1f} KB")

    write("assembly.json", pick(is_assembly, populated=True))
    write("assembly_massproperties.json", pick(is_assembly_massproperties))
    write(
        "partstudio_massproperties.json",
        pick(is_massproperties, name_contains=MAIN_PART_STUDIO),
    )
    write("parts_materials.json", pick(is_parts_list, name_contains=MAIN_PART_STUDIO))

    tessellation = pick(is_tessellation, name_contains=MAIN_PART_STUDIO)
    write("tessellation.json", trim_tessellation(tessellation) if tessellation else None)

    # The empty creation-time version, which the resolver must decline to build
    # against. Deliberately kept: it is the reason the workspace fallback exists.
    for path, payload in responses:
        if is_assembly(payload) and not payload["rootAssembly"].get("occurrences"):
            write("assembly_empty_version.json", payload)
            break

    # Per-source fixtures, so the end-to-end build test sees all five Part
    # Studios rather than the main one repeated. Without these the build finds
    # 15 of 26 parts and the reconciliation check cannot be exercised at all.
    print("  per-source:")
    for path, payload in responses:
        if "_e_" not in path.name:
            continue
        # Cache stems truncate at different points per endpoint, so normalise
        # to a fixed-length element prefix for a stable fixture name.
        element = path.name.split("_e_")[1].split("_")[0].split("__")[0][:12]
        if is_massproperties(payload):
            write(f"source_{element}_mass.json", payload)
        elif is_parts_list(payload):
            write(f"source_{element}_parts.json", payload)
        elif is_tessellation(payload):
            write(f"source_{element}_tess.json", decimate_tessellation(payload), compact=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
