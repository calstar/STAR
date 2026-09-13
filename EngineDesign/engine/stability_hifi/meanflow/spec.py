"""The ``MeanFlowSpec`` interface (paper Section V.A).

Every eigensolver input passes through this one container, so mean-flow fidelity
(synthetic uniform field -> parametric generator -> warm-started SU2 RANS) can be
swapped without touching the mesh, assembly, or eigensolver code. P0 only uses the
synthetic generator at the bottom of this file.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np

from engine.stability_hifi.acoustics.mesh import MeridionalMesh, cylinder_mesh, two_zone_duct_mesh


@dataclass
class FlameReference:
    """One flame reference point/ring for the flame-response closure (Eq. 7).

    Not used by the passive verification cases (V1-V2); populated once an active
    flame closure is added (V3 onward).
    """
    x_ref: float
    r_ref: float
    n_gain: float           # interaction index (n_p or n_u)
    tau: float              # time lag [s]
    normal: tuple = (1.0, 0.0)   # reference-plane normal, for velocity coupling (Eq. 7b)


@dataclass
class ProvenanceRecord:
    """Traceability metadata: every eigenvalue should be traceable to its mean flow."""
    generator: str
    propellants: Optional[str] = None
    Pc: Optional[float] = None
    MR: Optional[float] = None
    notes: str = ""


@dataclass
class MeanFlowSpec:
    """Scalar (Helmholtz-tier) mean-flow fields on a meridional mesh (Eq. 9-10).

    ``c`` is the paper's per-node sound-speed field (Section V.A) — the right
    representation for any *smoothly varying* mean flow, which is what every real
    generator (parametric or CFD) produces. ``c_element``, an EngineDesign-specific
    addition not in the paper, is an escape hatch for synthetic verification cases that
    need a genuinely *discontinuous* material property a shared node cannot represent
    (verification case V2's temperature-jump duct is the only user of it in P0). When
    present, ``assemble_passive`` should be called with ``c_element`` instead of ``c``;
    ``c`` is still filled in (as a defensible smooth proxy) purely so the dataclass
    contract — "every field the paper lists is always populated" — holds even here.
    """
    mesh: MeridionalMesh
    rho: np.ndarray                       # (n_nodes,) mean density [kg/m^3]
    c: np.ndarray                         # (n_nodes,) sound speed [m/s]
    gamma: np.ndarray                     # (n_nodes,) specific heat ratio [-]
    qbar: np.ndarray                      # (n_nodes,) mean volumetric heat release [W/m^3]
    ubar: Optional[np.ndarray] = None     # (n_nodes, 2), None at Helmholtz tier
    refs: List[FlameReference] = field(default_factory=list)
    meta: Optional[ProvenanceRecord] = None
    c_element: Optional[np.ndarray] = None   # (n_tri,), set only for discontinuous test cases (see above)


def synthetic_uniform_cylinder(L: float, R: float, nx: int, nr: int,
                               *, c_sound: float, gamma: float = 1.2,
                               rho: float = 4.0) -> MeanFlowSpec:
    """Uniform-property closed cylinder mean flow (verification case V1).

    Constant sound speed / density / gamma everywhere, no heat release (passive) — the
    exact configuration the analytic mode formula in Section VII.A (case V1) assumes.
    """
    mesh = cylinder_mesh(L, R, nx, nr)
    n = mesh.n_nodes
    return MeanFlowSpec(
        mesh=mesh,
        rho=np.full(n, rho),
        c=np.full(n, c_sound),
        gamma=np.full(n, gamma),
        qbar=np.zeros(n),
        ubar=None,
        refs=[],
        meta=ProvenanceRecord(generator="synthetic_uniform_cylinder",
                              notes="V1 analytic-cylinder verification case; no real propellant/Pc/MR"),
    )


def synthetic_two_zone_duct(L1: float, L2: float, R: float, nx1: int, nx2: int, nr: int,
                            *, c1: float, c2: float, gamma: float = 1.2,
                            rho: float = 4.0) -> MeanFlowSpec:
    """Two-zone duct with a sound-speed (temperature) jump at x=L1 (verification case V2).

    ``c1`` applies on ``[0, L1]``, ``c2`` on ``[L1, L1+L2]`` — a step discontinuity, not
    a smooth profile, which is exactly why this uses ``c_element`` (see ``MeanFlowSpec``
    docstring) rather than the ordinary per-node ``c`` field. ``rho`` is passed through
    uniformly for now; density does jump physically alongside sound speed at a real
    temperature interface (rho = p/(R*T), same p, different T), but the passive
    Helmholtz operator (Eq. 10) only ever uses ``c``, so it plays no role in this case.
    """
    mesh, zone = two_zone_duct_mesh(L1, L2, R, nx1, nx2, nr)
    n = mesh.n_nodes
    c_element = np.where(zone == 1, c1, c2)
    # Per-node c is not physically meaningful across the jump (see docstring); fill it
    # with each node's "home" zone value (nodes exactly on the interface get c1) purely
    # so the dataclass field is populated with *something* traceable, never used by the solve.
    node_zone = np.ones(n, dtype=np.int64)
    right_of_interface = mesh.nodes[:, 0] > L1 + 1e-9
    node_zone[right_of_interface] = 2
    c_node_proxy = np.where(node_zone == 1, c1, c2)
    return MeanFlowSpec(
        mesh=mesh,
        rho=np.full(n, rho),
        c=c_node_proxy,
        c_element=c_element,
        gamma=np.full(n, gamma),
        qbar=np.zeros(n),
        ubar=None,
        refs=[],
        meta=ProvenanceRecord(generator="synthetic_two_zone_duct",
                              notes=f"V2 temperature-jump verification case; c1={c1}, c2={c2}, interface at x={L1}"),
    )
