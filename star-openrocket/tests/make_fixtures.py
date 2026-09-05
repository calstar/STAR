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


# Facets kept per body in tessellation.json. Adjacency survives truncation --
# facets within a face arrive in strip order and keep sharing edges -- so
# welding still collapses vertices, which is what test_tessellate asserts.
SCHEMA_FACETS = 40

# Keys Onshape sends that `parse_tessellation` never looks at. `normals` is
# always empty in practice; `btType` is repeated on every single vertex, which
# is most of the weight. `facetPoints` and `bodiesInfo` are kept at the top
# level on purpose -- a test asserts they are the decoys they look like.
TESSELLATION_PASSTHROUGH = ("btType", "facetPoints", "bodiesInfo", "documentId", "elementId")


def trim_tessellation(payload: dict) -> dict:
    """Shrink the schema fixture to what the parser actually reads.

    This used to keep whole bodies at full fidelity, which cost 25k lines and
    645 KB -- 60% of the entire subproject's diff -- for 924 facets nothing
    asserts the shape of. The tests here are about the response *schema*
    (bodies is a list, vertices are {x,y,z} objects, the top-level facetPoints
    is a decoy) and about welding; none of that needs a faithful surface, and
    geometric accuracy is covered in test_geometry.py against analytic solids.
    """
    kept = [b for b in payload.get("bodies", []) if b.get("id") in KEEP_BODIES]
    if not kept:
        kept = sorted(
            payload.get("bodies", []),
            key=lambda b: sum(len(f.get("facets", [])) for f in b.get("faces", [])),
        )[:2]
    trimmed = {key: payload.get(key) for key in TESSELLATION_PASSTHROUGH}
    trimmed["bodies"] = _decimate_bodies(kept, SCHEMA_FACETS, precision=7)
    return trimmed


# Facets kept per body in the decimated per-source fixtures. Enough to give
# every part a mesh and a non-degenerate centroid; the full model is ~50k
# facets, which is far past the repo's 5 MB file ceiling.
DECIMATE_FACETS = 30


def _decimate_bodies(bodies: list[dict], budget_per_body: int, precision: int) -> list[dict]:
    """Keep the first `budget_per_body` facets of each body, vertices only."""
    out = []
    for body in bodies:
        faces, budget = [], budget_per_body
        for face in body.get("faces", []):
            if budget <= 0:
                break
            facets = [
                {
                    "vertices": [
                        {
                            "x": round(v["x"], precision),
                            "y": round(v["y"], precision),
                            "z": round(v["z"], precision),
                        }
                        for v in facet["vertices"]
                    ]
                }
                for facet in (face.get("facets") or [])[:budget]
            ]
            if facets:
                faces.append({"id": face.get("id"), "facets": facets})
                budget -= len(facets)
        out.append({"id": body.get("id"), "name": body.get("name"), "faces": faces})
    return out


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
    bodies = _decimate_bodies(payload.get("bodies", []), DECIMATE_FACETS, precision=6)
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

    written: dict[str, str] = {}

    def write(name: str, payload: object | None, compact: bool = False) -> None:
        if payload is None:
            print(f"  {name}: SKIPPED (not in cache)")
            return
        text = json.dumps(payload, indent=None if compact else 1)
        # The main Part Studio is both "the generic example" and "one of the
        # five sources", so it used to be written twice under two names --
        # ~1700 identical lines in the diff. FakeClient already falls back from
        # a missing per-source fixture to the generic one, so skipping the copy
        # changes nothing it serves.
        duplicate = next((n for n, t in written.items() if t == text), None)
        if duplicate is not None:
            print(f"  {name}: SKIPPED (byte-identical to {duplicate})")
            return
        written[name] = text
        path = FIXTURES / name
        path.write_text(text)
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
