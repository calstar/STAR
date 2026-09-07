"""CEA cache tables -> plain contiguous float64 arrays the njit kernels can read.

Kept separate from kernels.py because this is the only place that touches the
CEACache object model; the kernels below it see nothing but arrays.
"""
from __future__ import annotations

import numpy as np


def cea_arrays(cache):
    """Grids + 7 property tables (float64, C-order), Cf_vac with the _ensure_cea fallback."""
    assert getattr(cache, "use_3d", False), "cache is not a 3D grid"
    Pc = np.ascontiguousarray(cache.Pc_grid, np.float64)
    MR = np.ascontiguousarray(cache.MR_grid, np.float64)
    eps = np.ascontiguousarray(cache.eps_grid, np.float64)
    cf_vac = getattr(cache, "Cf_vac_table", None)
    if cf_vac is None:
        from engine.pipeline.cea_cache import _isentropic_cf_vac
        gt = np.asarray(cache.gamma_table, np.float64)
        cf_vac = np.empty_like(gt)
        for k in range(gt.shape[2]):
            ek = float(eps[k])
            for i in range(gt.shape[0]):
                for j in range(gt.shape[1]):
                    cf_vac[i, j, k] = _isentropic_cf_vac(gt[i, j, k], ek)
    A = lambda t: np.ascontiguousarray(t, np.float64)
    return (Pc, MR, eps, A(cache.cstar_table), A(cache.Cf_table), A(cache.Tc_table),
            A(cache.gamma_table), A(cache.R_table), A(cache.M_table), A(cf_vac))



def _cea_arrays_cached(cache):
    """Memoise cea_arrays for a cache, storing the result ON the cache object.

    NOT keyed on id(cache): a freed cache's id can be reused, which would
    silently serve a previous config's CEA tables in a multi-config process
    (test sessions, GUI config switches). This is the same hazard
    native_injector._ensure_cea documents and defends against with a token; tying
    the memo to the object's own lifetime is simpler and cannot leak.
    """
    arr = getattr(cache, "_numba_cea_arrays", None)
    if arr is None:
        arr = cea_arrays(cache)
        try:
            cache._numba_cea_arrays = arr
        except Exception:
            pass  # cache rejects attributes -> rebuild per call (correct, slower)
    return arr
