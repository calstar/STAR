#!/usr/bin/env python3
"""Export runner-level golden vectors for the C parity tests.

Loads a canonical config, runs PintleEngineRunner.evaluate() across a grid of
(P_tank_O, P_tank_F) pairs, and flattens each result to JSON scalars. The C
test (test_chamber_golden / test_evaluate_golden) consumes this once the
chamber/evaluate/stability physics is ported. NEW FILE, read-only on engine/.

    python engine/native/tools/export_golden_vectors.py \
        --config configs/canonical/impinging.yaml \
        --out    engine/native/tests/golden/golden_impinging.json

Parity tolerances asserted by the C side (documented in README):
    Pc           rtol 1e-4
    F, mdot_*    rtol 1e-3
    margins      rtol 1e-2  (heuristic stability models)
"""
import argparse
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from engine.pipeline.io import load_config            # noqa: E402
from engine.core.runner import PintleEngineRunner     # noqa: E402

PSI = 6894.757293168


def flatten(obj, prefix, out):
    """Collect JSON-friendly scalar leaves into out[flat_key]."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            flatten(v, f"{prefix}.{k}" if prefix else str(k), out)
    elif isinstance(obj, (int, float)) and not isinstance(obj, bool):
        if np.isfinite(obj):
            out[prefix] = float(obj)
    elif isinstance(obj, bool):
        out[prefix] = int(obj)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="configs/canonical/impinging.yaml")
    ap.add_argument("--out", default="engine/native/tests/golden/golden_impinging.json")
    ap.add_argument("--n", type=int, default=24, help="number of pressure pairs")
    args = ap.parse_args()

    cfg = load_config(args.config)
    runner = PintleEngineRunner(cfg)

    # Sweep tank pressures around the canonical ~520-570 psi design band.
    lo_psi, hi_psi = 480.0, 620.0
    rng = np.random.default_rng(7)
    pairs = []
    for i in range(args.n):
        po = lo_psi + (hi_psi - lo_psi) * (i / max(args.n - 1, 1))
        pf = po + float(rng.uniform(-15.0, 15.0))
        pairs.append((po * PSI, pf * PSI))

    vectors = []
    n_ok = 0
    for (P_O, P_F) in pairs:
        rec = {"P_tank_O": P_O, "P_tank_F": P_F}
        try:
            res = runner.evaluate(P_O, P_F, silent=True)
            flat = {}
            flatten(res, "", flat)
            # Keep the keys Layer 1 / the C test care about; drop bulky arrays.
            keep_prefixes = (
                "Pc", "mdot_O", "mdot_F", "mdot_total", "MR", "F", "Isp",
                "cstar_actual", "cstar_ideal", "eta_cstar", "Tc", "gamma", "R",
                "Cf_actual", "Cf_ideal", "eps", "A_throat", "A_exit",
                "P_exit", "P_throat", "T_exit", "v_exit",
                "momentum_ratio", "delta_P", "SMD", "smd",
                "chug", "acoustic", "feed", "stability", "margin",
            )
            for k, v in flat.items():
                if any(p in k for p in keep_prefixes):
                    rec[k] = v
            rec["_ok"] = 1
            n_ok += 1
        except Exception as e:  # noqa: BLE001
            rec["_ok"] = 0
            rec["_error"] = str(e)[:200]
        vectors.append(rec)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(vectors, f, indent=1)
    print(f"[ok] wrote {args.out}  ({n_ok}/{len(pairs)} evaluated)")


if __name__ == "__main__":
    main()
