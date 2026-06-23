#!/usr/bin/env python3
"""Side-by-side Python vs C timing/parity. NOT wired into production.

Final target (per spec): time runner.evaluate(silent=True) vs ed_evaluate+
ed_stability over the same inputs; exit 1 if the C path is <10x on the combined
evaluate+stability path.

Stage 1: ed_evaluate is not yet implemented, so the combined comparison reports
SKIP (exit 77). What IS compared now is the CEA lookup overlap — the one hot-path
kernel ported so far — both for numerical parity and for the Python-vs-C speed
ratio, which validates the comparison methodology end to end.

    python engine/native/python/bench_compare.py \
        --config configs/canonical/impinging.yaml
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from engine.pipeline.io import load_config          # noqa: E402
from engine.pipeline.cea_cache import CEACache       # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ed_native  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="configs/canonical/impinging.yaml")
    ap.add_argument("--tables", default=os.path.join(ROOT, "engine/native/tests/golden/cea_tables.bin"))
    ap.add_argument("--n", type=int, default=100000)
    args = ap.parse_args()

    if not os.path.exists(args.tables):
        print(f"[skip] missing {args.tables}; run tools/export_cea_tables.py first")
        return 77

    cfg = load_config(args.config)
    cache = CEACache(cfg.combustion.cea)

    nat = ed_native.load()
    nat.cea_load(args.tables)

    rng = np.random.default_rng(1)
    MRs = rng.uniform(cache.MR_min, cache.MR_max, args.n)
    Pcs = rng.uniform(cache.Pc_min, cache.Pc_max, args.n)
    Eps = rng.uniform(cache.eps_min, cache.eps_max, args.n)

    # ---- parity spot check ----
    max_rel = 0.0
    for i in range(0, args.n, max(args.n // 200, 1)):
        py = cache.eval(float(MRs[i]), float(Pcs[i]), 101325.0, float(Eps[i]))
        c = nat.cea_eval(float(MRs[i]), float(Pcs[i]), float(Eps[i]))
        for key, cv in (("cstar_ideal", c.cstar_ideal), ("Tc", c.Tc),
                        ("gamma", c.gamma), ("R", c.R)):
            pv = py[key]
            if abs(pv) > 0:
                max_rel = max(max_rel, abs(cv - pv) / abs(pv))
    print(f"CEA parity: max relative error over spot-check = {max_rel:.2e}")
    if max_rel > 1e-6:
        print("[FAIL] CEA parity exceeds 1e-6")
        return 1

    # ---- timing ----
    t0 = time.perf_counter()
    for i in range(args.n):
        cache.eval(float(MRs[i]), float(Pcs[i]), 101325.0, float(Eps[i]))
    t_py = time.perf_counter() - t0

    t0 = time.perf_counter()
    for i in range(args.n):
        nat.cea_eval(float(MRs[i]), float(Pcs[i]), float(Eps[i]))
    t_c = time.perf_counter() - t0

    print(f"CEA eval  Python: {t_py/args.n*1e9:8.1f} ns/call")
    print(f"CEA eval  C(ctypes): {t_c/args.n*1e9:8.1f} ns/call  (incl. ctypes overhead)")
    print(f"CEA eval  speedup: {t_py/t_c:.1f}x  (ctypes-bound; native-native is far higher — see bench_evaluate)")

    # ---- combined evaluate+stability path ----
    rc, _ = nat.evaluate(ed_native.C.create_string_buffer(nat.lib.ed_sizeof_engine_state()),
                         5e6, 5e6)
    if rc == ed_native.ED_ERR_NOT_IMPLEMENTED:
        print("[skip] ed_evaluate+stability not yet implemented; combined 10x gate deferred.")
        return 77

    print("[todo] combined evaluate+stability comparison")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
