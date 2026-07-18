#!/usr/bin/env python3
"""Export a CEACache to the flat .bin consumed by ed_cea_load, plus a JSON of
reference eval() samples for the C parity test.

NEW FILE — reads the existing engine package read-only; modifies nothing under
engine/. Run from the repository root (EngineDesign/):

    python engine/native/tools/export_cea_tables.py \
        --config configs/canonical/impinging.yaml \
        --out    engine/native/tests/golden

Outputs:
    <out>/cea_tables.bin    little-endian: "EDCA", i32 version=2, i32 n_pc/n_mr/n_eps,
                            f64 Pc_grid, MR_grid, eps_grid, then cstar,Cf,Tc,gamma,R,M,
                            Cf_vac tables (C-order, n_pc*n_mr*n_eps each).
                            (ed_cea_load also still reads version=1 files, which
                            lack the Cf_vac table.)
    <out>/cea_samples.json  list of {MR,Pc,Pa,eps, cstar_ideal,Cf_ideal,Tc,gamma,R,M}
                            from CEACache.eval(), incl. interior + clamp-edge points.
"""
import argparse
import json
import os
import struct
import sys

import numpy as np

# Repo root = three levels up from this file (engine/native/tools/).
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from engine.pipeline.io import load_config          # noqa: E402
from engine.pipeline.cea_cache import CEACache       # noqa: E402


def _c64(a):
    return np.ascontiguousarray(a, dtype=np.float64)


def write_bin(cache, path):
    Pc = _c64(cache.Pc_grid)
    MR = _c64(cache.MR_grid)
    eps = _c64(cache.eps_grid)
    n_pc, n_mr, n_eps = len(Pc), len(MR), len(eps)
    # Format v2: append the Cf_vac table (RPA delivered-thrust basis). Old caches
    # without the column get the same isentropic per-gridpoint fallback the
    # runtime dump (native_injector._ensure_cea) uses.
    cf_vac = getattr(cache, "Cf_vac_table", None)
    if cf_vac is None:
        from engine.pipeline.cea_cache import _isentropic_cf_vac
        gamma_t = np.asarray(cache.gamma_table, dtype=np.float64)
        cf_vac = np.empty_like(gamma_t)
        for k in range(gamma_t.shape[2]):
            for i in range(gamma_t.shape[0]):
                for j in range(gamma_t.shape[1]):
                    cf_vac[i, j, k] = _isentropic_cf_vac(gamma_t[i, j, k], float(eps[k]))
    tables = [cache.cstar_table, cache.Cf_table, cache.Tc_table,
              cache.gamma_table, cache.R_table, cache.M_table, cf_vac]
    for t in tables:
        if t.shape != (n_pc, n_mr, n_eps):
            raise ValueError(f"table shape {t.shape} != grid {(n_pc, n_mr, n_eps)}")
    with open(path, "wb") as f:
        f.write(b"EDCA")
        f.write(struct.pack("<i", 2))
        f.write(struct.pack("<iii", n_pc, n_mr, n_eps))
        f.write(Pc.tobytes()); f.write(MR.tobytes()); f.write(eps.tobytes())
        for t in tables:
            f.write(_c64(t).tobytes())
    return n_pc, n_mr, n_eps


def make_samples(cache):
    """Interior grid-aligned, off-grid, and clamp-edge probe points."""
    Pc_lo, Pc_hi = float(cache.Pc_min), float(cache.Pc_max)
    MR_lo, MR_hi = float(cache.MR_min), float(cache.MR_max)
    eps_lo, eps_hi = float(cache.eps_min), float(cache.eps_max)

    rng = np.random.default_rng(12345)
    pts = []
    # Random interior points.
    for _ in range(40):
        pts.append((
            float(rng.uniform(MR_lo, MR_hi)),
            float(rng.uniform(Pc_lo, Pc_hi)),
            float(rng.uniform(eps_lo, eps_hi)),
        ))
    # Exact grid corners and a few exact nodes (boundary-weight parity).
    for mr in (MR_lo, MR_hi, cache.MR_grid[5], cache.MR_grid[17]):
        for pc in (Pc_lo, Pc_hi, cache.Pc_grid[3]):
            for ep in (eps_lo, eps_hi, cache.eps_grid[9]):
                pts.append((float(mr), float(pc), float(ep)))
    # Out-of-range points to exercise the clamp.
    pts += [
        (MR_lo - 0.5, Pc_lo - 1e6, eps_lo - 2.0),
        (MR_hi + 0.5, Pc_hi + 1e6, eps_hi + 2.0),
        (3.0, Pc_hi * 2, 8.0),
    ]

    samples = []
    for MR, Pc, eps in pts:
        r = cache.eval(MR, Pc, 101325.0, eps)
        samples.append({
            "MR": MR, "Pc": Pc, "Pa": 101325.0, "eps": eps,
            "cstar_ideal": r["cstar_ideal"], "Cf_ideal": r["Cf_ideal"],
            "Tc": r["Tc"], "gamma": r["gamma"], "R": r["R"], "M": r["M"],
        })
    return samples


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="configs/canonical/impinging.yaml")
    ap.add_argument("--out", default="engine/native/tests/golden")
    args = ap.parse_args()

    cfg = load_config(args.config)
    cache = CEACache(cfg.combustion.cea)
    if not cache.use_3d:
        raise SystemExit("Expected a 3D CEA cache (Pc, MR, eps).")

    os.makedirs(args.out, exist_ok=True)
    bin_path = os.path.join(args.out, "cea_tables.bin")
    json_path = os.path.join(args.out, "cea_samples.json")

    n = write_bin(cache, bin_path)
    samples = make_samples(cache)
    with open(json_path, "w") as f:
        json.dump(samples, f, indent=1)

    print(f"[ok] wrote {bin_path}  grid={n}")
    print(f"[ok] wrote {json_path}  ({len(samples)} samples)")


if __name__ == "__main__":
    main()
