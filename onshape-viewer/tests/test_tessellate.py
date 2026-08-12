"""Tessellation parsing against the real response schema."""

from __future__ import annotations

import numpy as np

from backend.onshape.tessellate import parse_tessellation


def test_parses_bodies_as_a_list_keyed_by_id(tessellation):
    """orkv2.md Phase 3 describes `partId -> faces[]`; the API returns a list
    of bodies whose `id` is the part id. Parsing it as a dict yields nothing."""
    assert isinstance(tessellation["bodies"], list)

    meshes = parse_tessellation(tessellation)
    assert meshes
    for part_id, mesh in meshes.items():
        assert mesh.part_id == part_id


def test_vertices_are_named_objects_not_arrays(tessellation):
    """Vertex components arrive as {"x":_, "y":_, "z":_}, not [x, y, z]."""
    facet = tessellation["bodies"][0]["faces"][0]["facets"][0]
    assert set(facet["vertices"][0]) >= {"x", "y", "z"}


def test_facet_points_and_bodies_info_are_decoys(tessellation):
    """These top-level keys exist but are empty; the geometry is under `bodies`."""
    assert not tessellation.get("facetPoints")
    assert not tessellation.get("bodiesInfo")


def test_meshes_are_indexed_and_welded(tessellation):
    meshes = parse_tessellation(tessellation)
    for mesh in meshes.values():
        assert mesh.indices.shape[1] == 3
        assert mesh.indices.max() < len(mesh.vertices)
        # Welding must actually reduce the facet-soup vertex count.
        assert len(mesh.vertices) <= mesh.facet_count * 3


def test_welding_reduces_vertex_count(tessellation):
    meshes = parse_tessellation(tessellation)
    big = max(meshes.values(), key=lambda m: m.facet_count)
    raw_count = big.facet_count * 3
    assert len(big.vertices) < raw_count, "shared edges should collapse"


def test_triangle_count_matches_facet_count(tessellation):
    meshes = parse_tessellation(tessellation)
    for mesh in meshes.values():
        assert mesh.triangle_count == mesh.facet_count


def test_empty_payload_yields_no_meshes():
    assert parse_tessellation({}) == {}
    assert parse_tessellation({"bodies": []}) == {}


def test_body_without_facets_is_skipped():
    payload = {"bodies": [{"id": "AAA", "faces": [{"facets": []}]}]}
    assert parse_tessellation(payload) == {}


def test_non_triangular_facets_are_dropped():
    """Onshape emits triangles; anything else is malformed and guessing is worse."""
    payload = {
        "bodies": [
            {
                "id": "AAA",
                "faces": [
                    {
                        "facets": [
                            {"vertices": [{"x": 0, "y": 0, "z": 0}, {"x": 1, "y": 0, "z": 0}]},
                            {
                                "vertices": [
                                    {"x": 0, "y": 0, "z": 0},
                                    {"x": 1, "y": 0, "z": 0},
                                    {"x": 0, "y": 1, "z": 0},
                                ]
                            },
                        ]
                    }
                ],
            }
        ]
    }
    meshes = parse_tessellation(payload)
    assert meshes["AAA"].facet_count == 1


def test_face_groups_partition_the_triangles(tessellation):
    """Face groups must cover every triangle exactly once, in order."""
    meshes = parse_tessellation(tessellation)
    for mesh in meshes.values():
        assert len(mesh.face_ids) == len(mesh.face_tri_counts)
        assert sum(mesh.face_tri_counts) == mesh.triangle_count
        per_tri = mesh.face_id_per_triangle()
        assert per_tri.shape == (mesh.triangle_count,)
        assert per_tri.max() < len(mesh.face_ids)


def test_face_ids_are_preserved():
    """A body's face ids survive parsing rather than being flattened away."""
    payload = {
        "bodies": [
            {
                "id": "AAA",
                "faces": [
                    {"id": "F1", "facets": [
                        {"vertices": [{"x": 0, "y": 0, "z": 0}, {"x": 1, "y": 0, "z": 0}, {"x": 0, "y": 1, "z": 0}]},
                    ]},
                    {"id": "F2", "facets": [
                        {"vertices": [{"x": 0, "y": 0, "z": 1}, {"x": 1, "y": 0, "z": 1}, {"x": 0, "y": 1, "z": 1}]},
                        {"vertices": [{"x": 1, "y": 1, "z": 1}, {"x": 1, "y": 0, "z": 1}, {"x": 0, "y": 1, "z": 1}]},
                    ]},
                ],
            }
        ]
    }
    mesh = parse_tessellation(payload)["AAA"]
    assert mesh.face_ids == ["F1", "F2"]
    assert mesh.face_tri_counts == [1, 2]
    assert mesh.face_id_per_triangle().tolist() == [0, 1, 1]


def test_vertices_are_float64(tessellation):
    """Mass-adjacent maths runs on these, so precision is kept until GLB export."""
    mesh = next(iter(parse_tessellation(tessellation).values()))
    assert mesh.vertices.dtype == np.float64
