"""Solvers for the active-flame nonlinear eigenvalue problem (NLEVP), verification
case V3. This is the first place ``lambda`` enters nonlinearly (through the flame
delay ``exp(-lambda*tau)``, Eq. 7/11), so it is the first place the paper's Section IV
solver hierarchy is actually needed rather than the plain linear GEVP of ``passive.py``.

The discrete operator being solved (Eq. 11, specialized to this package's cases: a
single azimuthal wavenumber m=0, a constant boundary-admittance matrix C from a compact
nozzle, and a single compact flame reference, so F(lambda) is rank 1):

    N(lambda) p = [ K + lambda*C + lambda^2*M2 - lambda*flame_gain*exp(-lambda*tau)*g@b.T ] p = 0

``K``, ``C``, ``M2`` come from ``acoustics/assembly.py``. ``g`` and ``b`` are TWO
DIFFERENT vectors, not the same one reused (see the long comment in
``acoustics/assembly.py`` above ``disk_load_vector`` for why conflating them is a real,
previously-caught bug): ``b`` (``assembly.point_sampling_vector``) is a plain point
sample of the pressure at the flame's reference location (Eq. 7a); ``g``
(``assembly.disk_load_vector``) is the r-weighted energy-injection weight, carrying the
same ``r dOmega`` measure as every other matrix here. ``flame_gain`` and ``tau`` are the
lumped Crocco interaction strength and time lag (see ``validation/v3_ntau_duct.py`` for
how they relate to the physical n, tau of Eq. 2.1 and to this module's own dispersion
relation).

Scale note: everything here is DENSE (``numpy``/``scipy.linalg``, not sparse/Krylov).
That is a deliberate scope choice for P0's verification meshes (a few hundred nodes):
the sparse/shift-invert machinery of Section IV.E is already exercised (for the
LINEAR-in-lambda case) by ``passive.py``; this module's job is to validate the
NONLINEAR delay handling, a separate concern, at a problem size where a dense solve is
simpler to write and just as fast. A production-scale (P1+) NLEVP solver would still
need the sparse Krylov kernel underneath the same two algorithms below.
"""

from __future__ import annotations

from typing import Tuple

import numpy as np
from scipy import linalg as sla


def _frozen_A1(C: np.ndarray, flame_gain: float, tau: float,
              g: np.ndarray, b: np.ndarray, lam: complex) -> np.ndarray:
    """The coefficient of ``lambda`` in N(lambda), with the flame's delay factor
    ``exp(-lambda*tau)`` FROZEN at the current iterate ``lam`` (Algorithm 1, step 3).

    N(lambda) = K + lambda*[C - flame_gain*exp(-lam*tau)*g@b.T] + lambda^2*M2 once
    frozen — a genuine QUADRATIC eigenvalue problem in lambda, since freezing the delay
    factor at a fixed number removes the only source of nonlinearity.
    """
    return C - flame_gain * np.exp(-lam * tau) * np.outer(g, b)


def _companion_solve(A0: np.ndarray, A1: np.ndarray, A2: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """All eigenpairs of the quadratic pencil ``A0 + lambda*A1 + lambda^2*A2 = 0`` via
    the standard companion linearization to a size-2N generalized eigenvalue problem
    (Algorithm 1, step 5 — "companion-linearize to GEVP of size 2N_h").

    Writing ``z = [p; lambda*p]``, one checks by direct substitution that

        [[0, I], [-A0, -A1]] z = lambda * [[I, 0], [0, A2]] z

    reproduces exactly ``A0 p + lambda A1 p + lambda^2 A2 p = 0`` (the top block row
    gives the trivial identity ``lambda*p = lambda*p``; the bottom block row gives the
    QEP once that identity is substituted in). Solved directly and densely
    (``scipy.linalg.eig``) since P0's verification meshes are small — see module
    docstring for why that is an adequate, deliberate scope choice here.
    """
    n = A0.shape[0]
    Z = np.zeros((n, n), dtype=complex)
    I = np.eye(n, dtype=complex)
    L0 = np.block([[Z, I], [-A0, -A1]])
    L1 = np.block([[I, Z], [Z, A2]])
    eigvals, eigvecs = sla.eig(L0, L1)
    p_vecs = eigvecs[:n, :]   # the physical eigenvector is the top half of z
    return eigvals, p_vecs


def fixed_point_solve(K: np.ndarray, C: np.ndarray, M2: np.ndarray, flame_gain: float,
                      tau: float, g: np.ndarray, b: np.ndarray, lambda_seed: complex,
                      *, tol: float = 1e-9, max_iter: int = 50
                      ) -> Tuple[complex, np.ndarray, int]:
    """Algorithm 1 (Section IV.B): frozen-delay fixed point, specialized to this
    package's single-flame-reference, dense-small-scale case.

    At each outer iterate, freeze ``exp(-lambda*tau)`` at the current guess, solve the
    resulting *linear* (in the sense of ordinary QEP, not NLEVP) quadratic eigenvalue
    problem exactly via companion linearization, and take whichever of its 2N
    eigenvalues is nearest the current guess as the next iterate. Converges linearly;
    the paper reports 3-8 outer iterations for realistic parameters, matched here.

    Returns ``(lambda, p, n_iterations)``.
    """
    lam = complex(lambda_seed)
    p = None
    for it in range(max_iter):
        A1 = _frozen_A1(C, flame_gain, tau, g, b, lam)
        eigvals, eigvecs = _companion_solve(K.astype(complex), A1, M2.astype(complex))
        idx = int(np.argmin(np.abs(eigvals - lam)))
        lam_new = eigvals[idx]
        p = eigvecs[:, idx]
        if abs(lam_new - lam) < tol * max(abs(lam_new), 1.0):
            return lam_new, p, it + 1
        lam = lam_new
    return lam, p, max_iter


def residual_N(K: np.ndarray, C: np.ndarray, M2: np.ndarray, flame_gain: float, tau: float,
               g: np.ndarray, b: np.ndarray, lam: complex, p: np.ndarray) -> np.ndarray:
    """N(lambda) @ p — the raw NLEVP residual, used to check solver agreement/quality."""
    N = K + lam * C + lam ** 2 * M2 - lam * flame_gain * np.exp(-lam * tau) * np.outer(g, b)
    return N @ p


def newton_polish(K: np.ndarray, C: np.ndarray, M2: np.ndarray, flame_gain: float, tau: float,
                  g: np.ndarray, b: np.ndarray, lambda0: complex, p0: np.ndarray,
                  *, tol: float = 1e-12, max_iter: int = 30
                  ) -> Tuple[complex, np.ndarray, int]:
    """Bordered Newton polish (Section IV.C), solving the *true* NLEVP (delay left in,
    not frozen) to quadratic convergence from the fixed-point solver's output.

    The bordered system (paper's own equations, Section IV.C):

        [[N(lambda),      N'(lambda) p],   [dp     ]     [ N(lambda) p    ]
         [c^H,             0          ]] @ [dlambda] = - [ c^H p - 1       ]

    with the normalization row ``c^H p = 1`` fixing scale/phase (paper uses a generic
    ``c``; here ``c = e_k``, a unit vector at whichever component of ``p`` has the
    largest magnitude — a simple, standard pivoting choice so the constraint row is
    never close to singular).

    N'(lambda) = C + 2*lambda*M2 - flame_gain*exp(-lambda*tau)*(1 - lambda*tau)*outer(g,b)
    (derivative of the "-lambda*flame_gain*exp(-lambda*tau)" term in N(lambda) w.r.t.
    lambda; C and M2 contribute their usual constant/2*lambda derivatives).
    """
    lam = complex(lambda0)
    p = p0.astype(complex).copy()
    n = len(p)
    k = int(np.argmax(np.abs(p)))
    p = p / p[k]   # normalize so the pivot component is exactly 1, matching c^H p = 1

    for it in range(max_iter):
        N = K + lam * C + lam ** 2 * M2 - lam * flame_gain * np.exp(-lam * tau) * np.outer(g, b)
        Nprime = (C + 2.0 * lam * M2
                 - flame_gain * np.exp(-lam * tau) * (1.0 - lam * tau) * np.outer(g, b))

        bordered = np.zeros((n + 1, n + 1), dtype=complex)
        bordered[:n, :n] = N
        bordered[:n, n] = Nprime @ p
        bordered[n, k] = 1.0   # c^H = e_k^T

        rhs = np.zeros(n + 1, dtype=complex)
        rhs[:n] = -(N @ p)
        rhs[n] = -(p[k] - 1.0)

        delta = np.linalg.solve(bordered, rhs)
        dp, dlam = delta[:n], delta[n]
        p = p + dp
        lam = lam + dlam

        if abs(dlam) < tol * max(abs(lam), 1.0) and np.linalg.norm(dp) < tol * max(np.linalg.norm(p), 1.0):
            return lam, p, it + 1

    return lam, p, max_iter
