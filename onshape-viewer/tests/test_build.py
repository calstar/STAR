"""End-to-end build against fixtures: manifest, GLB, and the join between them."""

from __future__ import annotations

import json

import numpy as np
import pytest
from pygltflib import GLTF2

from backend.onshape import build as build_mod
from conftest import (
    ASSEMBLY_CENTROID_Z,
    ASSEMBLY_MASS,
    EXPECTED_PARTS,
    EXPECTED_WITHOUT_MATERIAL,
    FakeClient,
)

WORKSPACE_URL = (
    "https://starberkeley.onshape.com/documents/dbf4d35d8e9fe37819466f72"
    "/w/1df1c851058d46a5e5f08114/e/a194351ef67344579daff54b"
)


@pytest.fixture
def built(tmp_path, monkeypatch, empty_version_assembly):
    """Run the real build with every network call served from fixtures."""

    def make_client(*args, **kwargs):
        client = FakeClient()
        original = client.get_json

        def get_json(path, params=None):
            # Force the workspace-microversion path, as on the real document.
            if path.startswith("/assemblies/") and "/v/" in path:
                client.requests.append((path, params or {}))
                return empty_version_assembly
            return original(path, params)

        client.get_json = get_json  # type: ignore[method-assign]
        return client

    monkeypatch.setattr(build_mod, "OnshapeClient", make_client)
    manifest = build_mod.build(WORKSPACE_URL, output_dir=tmp_path)
    return manifest, tmp_path


def test_writes_both_artifacts(built):
    _, output = built
    assert (output / "model.glb").exists()
    assert (output / "manifest.json").exists()


def test_manifest_matches_written_file(built):
    manifest, output = built
    assert json.loads((output / "manifest.json").read_text()) == manifest


def test_part_count(built):
    manifest, _ = built
    assert manifest["totals"]["partCount"] == EXPECTED_PARTS
    assert len(manifest["parts"]) == EXPECTED_PARTS


def test_mass_reconciles_with_the_assembly_total(built):
    """The acceptance check: dropped parts show up here and nowhere else.

    Comparable because nothing is substituted for the parts Onshape has no mass
    for: they weigh nothing on both sides of this comparison.
    """
    manifest, _ = built
    totals = manifest["totals"]
    assert totals["mass"] == pytest.approx(ASSEMBLY_MASS, rel=1e-9)
    assert totals["reconciled"] is True
    assert totals["reconciliationRelative"] < 1e-6


def test_centroid_matches_onshape(built):
    manifest, _ = built
    totals = manifest["totals"]
    assert totals["centroid"][2] == pytest.approx(ASSEMBLY_CENTROID_Z, abs=1e-9)
    assert totals["centroid"] == pytest.approx(totals["assemblyCentroid"], abs=1e-9)


def test_parts_without_material_are_counted_and_carry_no_mass(built):
    manifest, _ = built
    assert manifest["totals"]["partsWithoutMaterial"] == EXPECTED_WITHOUT_MATERIAL

    unassigned = [part for part in manifest["parts"] if part["materialDefaulted"]]
    assert len(unassigned) == EXPECTED_WITHOUT_MATERIAL
    for part in unassigned:
        assert part["material"] is None
        # No density is substituted: mass stays zero until a user assigns one.
        assert part["mass"] == 0.0
        # Volume is exact regardless of material, and is what an assigned
        # density would be applied to.
        assert part["volume"] > 0


def test_unassigned_parts_are_not_placed_at_the_origin(built):
    """Onshape zeroes the centroid along with the mass; the mesh has to supply it.

    Without this, a mass assigned later in the viewer lands at the Part Studio
    origin and drags the centre of mass somewhere plainly wrong.
    """
    manifest, _ = built
    unassigned = [part for part in manifest["parts"] if part["materialDefaulted"]]
    non_zero = [part for part in unassigned if any(abs(c) > 1e-9 for c in part["centroidLocal"])]
    assert len(non_zero) == len(unassigned)


def test_total_mass_is_only_the_parts_onshape_weighed(built):
    manifest, _ = built
    totals = manifest["totals"]
    weighed = [part for part in manifest["parts"] if not part["materialDefaulted"]]
    assert totals["mass"] == pytest.approx(sum(part["mass"] for part in weighed))


def test_part_studio_names_accompany_instance_names(built):
    """The viewer needs both to strip Onshape's instance counter safely.

    "Bulkhead <2>" is the instance; "Bulkhead" is the part. Without the second,
    a part genuinely named with angle brackets is indistinguishable from a
    counter and gets truncated.
    """
    manifest, _ = built
    named = [part for part in manifest["parts"] if part["partName"]]
    assert len(named) == len(manifest["parts"])
    for part in named:
        assert part["name"].startswith(part["partName"])


def test_warns_about_parts_without_material(built):
    manifest, _ = built
    assert any("no material" in warning for warning in manifest["warnings"])


def test_records_how_the_ref_was_resolved(built):
    manifest, _ = built
    source = manifest["source"]
    assert source["resolvedFrom"] == "workspace-microversion"
    assert source["microversionId"] == "53ff9eb118e83e8db40bcc4f"
    assert source["versionId"] is None


def test_declares_up_axis_handling(built):
    """The viewer relies on this to know the swap is already baked into the GLB."""
    manifest, _ = built
    assert manifest["upAxisHandling"] == "glb-root"


def test_centroid_world_is_the_transformed_local_centroid(built):
    manifest, _ = built
    for part in manifest["parts"]:
        matrix = np.asarray(part["transform"], dtype=np.float64).reshape(4, 4)
        expected = matrix[:3, :3] @ np.asarray(part["centroidLocal"]) + matrix[:3, 3]
        assert part["centroidWorld"] == pytest.approx(expected.tolist(), abs=1e-12)


def test_weighted_sum_of_parts_reproduces_the_total(built):
    """What the browser computes at runtime must match what the build reports."""
    manifest, _ = built
    parts = manifest["parts"]
    total = sum(part["mass"] for part in parts)
    acc = np.zeros(3)
    for part in parts:
        acc += np.asarray(part["centroidWorld"]) * part["mass"]
    assert (acc / total).tolist() == pytest.approx(manifest["totals"]["centroid"], abs=1e-12)


# -- GLB -------------------------------------------------------------------


def test_glb_node_extras_join_the_manifest(built):
    """`key` is the single join between geometry and physics."""
    manifest, output = built
    gltf = GLTF2().load(str(output / "model.glb"))

    glb_keys = {node.extras["key"] for node in gltf.nodes if node.extras}
    manifest_keys = {part["key"] for part in manifest["parts"] if part["hasGeometry"]}

    assert glb_keys == manifest_keys


def test_glb_reuses_geometry_across_occurrences(built):
    """Duplicating geometry per instance is the thing this design avoids."""
    manifest, output = built
    gltf = GLTF2().load(str(output / "model.glb"))
    placed = [node for node in gltf.nodes if node.extras]
    assert len(gltf.meshes) < len(placed)


def test_glb_has_one_root_carrying_the_axis_swap(built):
    """Applied exactly once, here -- the viewer must not repeat it."""
    _, output = built
    gltf = GLTF2().load(str(output / "model.glb"))

    assert len(gltf.scenes[0].nodes) == 1
    root = gltf.nodes[gltf.scenes[0].nodes[0]]
    assert root.rotation == pytest.approx([-0.7071067811865476, 0, 0, 0.7071067811865476])
    assert root.mesh is None
    assert len(root.children) == len([n for n in gltf.nodes if n.extras])


def test_glb_node_matrices_are_column_major(built):
    """glTF wants column-major; Onshape gives row-major. The translation column
    is where a missing transpose shows up first."""
    manifest, output = built
    gltf = GLTF2().load(str(output / "model.glb"))
    by_key = {part["key"]: part for part in manifest["parts"]}

    for node in gltf.nodes:
        if not node.extras:
            continue
        row_major = np.asarray(by_key[node.extras["key"]]["transform"]).reshape(4, 4)
        written = np.asarray(node.matrix).reshape(4, 4)
        assert written == pytest.approx(row_major.T)
        # Translation lives in the last row once column-major.
        assert written[3, :3] == pytest.approx(row_major[:3, 3])


def test_glb_positions_have_accessor_bounds(built):
    """Required by spec for POSITION, and viewers use it to frame the scene."""
    _, output = built
    gltf = GLTF2().load(str(output / "model.glb"))
    for mesh in gltf.meshes:
        accessor = gltf.accessors[mesh.primitives[0].attributes.POSITION]
        assert accessor.min is not None and len(accessor.min) == 3
        assert accessor.max is not None and len(accessor.max) == 3
        assert all(lo <= hi for lo, hi in zip(accessor.min, accessor.max))


def test_glb_meshes_carry_face_groups(built):
    """Face grouping rides on the shared mesh so the viewer can pick a face."""
    _, output = built
    gltf = GLTF2().load(str(output / "model.glb"))
    for mesh in gltf.meshes:
        extras = mesh.extras or {}
        assert "faceIds" in extras and "faceTriCounts" in extras
        assert len(extras["faceIds"]) == len(extras["faceTriCounts"])
        assert sum(extras["faceTriCounts"]) > 0


# -- geometry sidecar ------------------------------------------------------


def test_geometry_sidecar_is_written(built):
    _, output = built
    assert (output / "geometry.json").exists()
    assert (output / "geometry.npz").exists()


def test_geometry_store_round_trips(built):
    """The sidecar reloads and every occurrence with geometry is present."""
    from backend.onshape.geometry_store import GeometryStore

    manifest, output = built
    store = GeometryStore.load(output)

    with_geometry = {p["key"] for p in manifest["parts"] if p["hasGeometry"]}
    assert set(store.occurrence_keys()) == with_geometry


def test_geometry_store_face_triangles_are_world_frame(built):
    """A picked face resolves to triangles placed by the occurrence transform."""
    from backend.onshape.geometry_store import GeometryStore

    manifest, output = built
    store = GeometryStore.load(output)
    faces = store.iter_faces()
    assert faces

    # Every face's triangles are (T, 3, 3) and finite.
    for fg in faces[:50]:
        assert fg.triangles.ndim == 3 and fg.triangles.shape[1:] == (3, 3)
        assert np.isfinite(fg.triangles).all()

    # faces_for is a strict subset resolving the requested (key, faceId) pairs.
    sel = [(faces[0].occurrence_key, faces[0].face_id)]
    got = store.faces_for(sel)
    assert [(g.occurrence_key, g.face_id) for g in got] == sel
