"""Passive (flame-off, rigid-wall) modal solve — the shift-invert Krylov kernel of
Section IV.E, specialized to the *linear* case that appears with no flame and no
boundary impedance.

With ``C = 0`` (rigid walls only) and ``F = 0`` (no active flame), the discrete NLEVP
(Eq. 11) collapses to

    (K + m^2 Km) p = -lambda^2 M2 p .

Writing ``mu = -lambda^2``, this is an ordinary real-symmetric *generalized* eigenvalue
problem ``A p = mu M2 p`` with ``A = K + m^2 Km``. Both ``A`` and ``M2`` are symmetric
positive semi-definite (a lossless rigid-wall cavity cannot amplify or dissipate), so
``mu >= 0`` and every eigenvalue is purely oscillatory: ``lambda = +/- i*sqrt(mu)``,
``omega = sqrt(mu)``, ``f = omega / (2 pi)``. This is exactly the passive-mode seeding
step of Algorithm 2 (paper Section IV.F, step 5) and case V1 of the verification ladder.

We solve it with shift-invert Lanczos (``scipy.sparse.linalg.eigsh``, which is symmetric
Arnoldi/Lanczos — the real-symmetric specialization of the Krylov-Schur kernel described
in Section IV.E): factor ``(A - sigma*M2)`` once and iterate on its action, which makes
the eigenvalues nearest the shift ``sigma`` the *extremal* (best-converging) ones of the
transformed operator, exactly the mechanism Section IV.E describes for the general
(non-symmetric, shift-invert Krylov-Schur) case.
"""

from __future__ import annotations

from typing import Tuple

import numpy as np
from scipy import sparse
from scipy.sparse.linalg import eigsh

from engine.stability_hifi.acoustics.assembly import assemble_passive
from engine.stability_hifi.acoustics.mesh import MeridionalMesh


def solve_passive_modes(mesh: MeridionalMesh, c_sound: np.ndarray, m: int,
                        *, n_modes: int, sigma: float) -> Tuple[np.ndarray, np.ndarray]:
    """Lowest ``n_modes`` passive acoustic frequencies and mode shapes at wavenumber ``m``.

    ``sigma`` is the shift [rad/s]^2 (i.e. an ``omega^2`` guess) placed near the band of
    interest — shift placement is not guesswork (Section IV.E): pass ``(2*pi*f_guess)**2``
    for whatever frequency band you expect from the analytic estimate.

    Axis regularity (Section III.E) is imposed here, not in ``assemble_passive``: for
    ``m == 0`` nothing is done (natural condition, automatic from the ``r``-weighted weak
    form); for ``m >= 1`` the r=0 axis nodes are eliminated (essential p=0 Dirichlet
    condition) before the solve and their (zero) values are scattered back afterward.

    Returns ``(freqs_hz, mode_shapes)`` with ``mode_shapes`` shape ``(n_nodes, n_modes)``,
    sorted by ascending frequency.
    """
    K, Km, M2 = assemble_passive(mesh, c_sound, m)
    A = (K + (m * m) * Km).tocsc()
    M = M2.tocsc()

    if m == 0:
        free = np.arange(mesh.n_nodes)
    else:
        axis = mesh.axis_nodes()
        keep = np.ones(mesh.n_nodes, dtype=bool)
        keep[axis] = False
        free = np.nonzero(keep)[0]
        A = A[free][:, free]
        M = M[free][:, free]

    k = min(n_modes, A.shape[0] - 2)
    if k < 1:
        raise ValueError("mesh too coarse for the requested number of modes")

    vals, vecs = eigsh(A, k=k, M=M, sigma=sigma, which="LM")
    order = np.argsort(vals)
    vals = np.clip(vals[order], 0.0, None)   # numerical noise can make near-zero mu slightly negative
    vecs = vecs[:, order]

    freqs_hz = np.sqrt(vals) / (2.0 * np.pi)

    full_vecs = np.zeros((mesh.n_nodes, vecs.shape[1]))
    full_vecs[free, :] = vecs
    return freqs_hz, full_vecs
