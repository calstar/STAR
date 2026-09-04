#!/usr/bin/env python3
"""Benchmark the Layer-1 optimizer inner loop: plain-Python vs full-native (C).

This is the *heaviest optimizer path on the config with the most C ports completed*
(impinging + ablative + advanced combustion => _can_handle_chamber is True, so every
converging candidate runs the whole physics chain in C via ed_evaluate).

Correct measurement is fiddly, so this script pins down the variables:

  * FORCE SERIAL (num_workers=1, in-process) -- the native fast-eval path lives in
    the ProcessPool worker function `_eval_candidate`; with a real pool it runs in
    child processes and is invisible/uncontrolled. Serial runs it in-process so the
    per-candidate cost is measured cleanly and the native-vs-fallback split is counted.
  * ONE CONDITION PER SUBPROCESS -- native availability is cached per-process and the
    Python run pins ED_USE_NATIVE=0; running both in one process cross-poisons. The
    driver re-execs this script once per mode.
  * WARMUP -- a throwaway 1-iteration solve first (loads the CEA cache, builds/loads
    the native lib, warms imports), then the counters reset and the timed run happens.

Two conditions, identical budget:
  * python : ED_USE_NATIVE=0  -> native disabled everywhere, incl. the chamber solve
             inside runner.evaluate. True all-Python baseline.
  * native : ED_USE_NATIVE=1, ED_LAYER1_NATIVE_EVAL=1 -> single C ed_evaluate per
             candidate; Python fallback only on a non-converged native solve.

The us/candidate NATIVE number is the bar a Numba kernel has to approach; Numba slots
in as a third mode once its kernel exists.

Run:
  .venv/bin/python -m scripts.bench_layer1_native_vs_python --max-iterations 12
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


# --- per-candidate counters ---------------------------------------------------
class _Counters:
    def reset(self):
        self.native_calls = 0   # native_injector.evaluate invocations
        self.native_none = 0    # ... that returned None (fell back to Python)
        self.runner_calls = 0   # PintleEngineRunner.evaluate invocations


C = _Counters()
C.reset()


def _install_instrumentation():
    from engine.native.python import native_injector as ni
    from engine.core.runner import PintleEngineRunner
    if getattr(ni.evaluate, "_benched", False):
        return
    _orig_native, _orig_runner = ni.evaluate, PintleEngineRunner.evaluate

    def native_evaluate(*a, **k):
        r = _orig_native(*a, **k)
        C.native_calls += 1
        if r is None:
            C.native_none += 1
        return r

    def runner_evaluate(self, *a, **k):
        C.runner_calls += 1
        return _orig_runner(self, *a, **k)

    native_evaluate._benched = True
    ni.evaluate = native_evaluate
    PintleEngineRunner.evaluate = runner_evaluate


def _one_optimization(config_path: Path, max_iterations: int, cma_restarts: int, seed: int):
    import numpy as np
    import engine.optimizer.layers.layer1_static_optimization as L1
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.io import load_config

    L1._get_num_workers = lambda cfg: 1  # force serial, in-process

    base_cfg = load_config(str(config_path))
    cfg = copy.deepcopy(base_cfg)
    req = cfg.design_requirements.model_dump()
    pcfg = {
        "mode": "optimizer_controlled",
        "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
        "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"]),
    }
    np.random.seed(seed)
    t0 = time.perf_counter()
    L1.run_layer1_optimization(
        cfg, PintleEngineRunner(copy.deepcopy(base_cfg)), req,
        target_burn_time=float(req.get("target_burn_time", 6.0)),
        tolerances={"thrust": 0.10, "apogee": 0.15},
        pressure_config=pcfg, layer1_smoke=True,
        layer1_max_iterations=int(max_iterations), layer1_cma_restarts=int(cma_restarts),
    )
    return time.perf_counter() - t0


def _run_condition(mode: str, config_path: Path, max_iterations: int, cma_restarts: int, seed: int):
    """Runs one condition in THIS process. Emits a JSON result line for the driver."""
    if mode == "python":
        os.environ["ED_USE_NATIVE"] = "0"
        os.environ["ED_LAYER1_NATIVE_EVAL"] = "0"
    else:
        os.environ["ED_USE_NATIVE"] = "1"
        os.environ["ED_LAYER1_NATIVE_EVAL"] = "1"

    _install_instrumentation()
    # warmup (loads CEA cache, builds native lib, warms imports) — discarded
    _one_optimization(config_path, max_iterations=1, cma_restarts=1, seed=seed)
    C.reset()
    wall = _one_optimization(config_path, max_iterations, cma_restarts, seed)
    cands = C.native_calls if C.native_calls else C.runner_calls
    out = {
        "mode": mode, "wall_s": wall, "candidates": cands,
        "native_calls": C.native_calls, "native_fallbacks": C.native_none,
        "runner_calls": C.runner_calls,
        "us_per_candidate": (wall / cands * 1e6) if cands else None,
    }
    print("BENCH_JSON " + json.dumps(out))
    return out


def _print_condition(o: dict):
    print(f"\n[{o['mode'].upper()}]")
    print(f"  wall-clock       : {o['wall_s']:8.3f} s")
    print(f"  candidate evals  : {o['candidates']}")
    if o["native_calls"]:
        went = o["native_calls"] - o["native_fallbacks"]
        print(f"  went native (C)  : {went}/{o['native_calls']} "
              f"({100.0*went/o['native_calls']:.0f}%)  |  fallback: {o['native_fallbacks']}")
    print(f"  runner.evaluate  : {o['runner_calls']} (fallback + finalization replay)")
    print(f"  us / candidate   : {o['us_per_candidate']:8.1f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=str, default="configs/impinging_lox_ch4_8000N.yaml")
    ap.add_argument("--max-iterations", type=int, default=12)
    ap.add_argument("--cma-restarts", type=int, default=1)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--mode", choices=["python", "native"], default=None,
                    help="internal: run a single condition in this process")
    args = ap.parse_args()

    cfg_path = (ROOT / args.config) if not os.path.isabs(args.config) else Path(args.config)

    if args.mode:  # child: run one condition
        _run_condition(args.mode, cfg_path, args.max_iterations, args.cma_restarts, args.seed)
        return

    # driver: spawn one subprocess per condition
    print(f"config: {cfg_path}")
    print(f"budget: max_iterations={args.max_iterations} cma_restarts={args.cma_restarts} "
          f"seed={args.seed}  (serial, in-process, warmup discarded)")
    results = {}
    for mode in ("python", "native"):
        cmd = [sys.executable, str(Path(__file__).resolve()),
               "--config", args.config, "--max-iterations", str(args.max_iterations),
               "--cma-restarts", str(args.cma_restarts), "--seed", str(args.seed),
               "--mode", mode]
        p = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True)
        line = next((l for l in p.stdout.splitlines() if l.startswith("BENCH_JSON ")), None)
        if not line:
            print(f"!! {mode} run produced no result. stderr tail:\n" + "\n".join(p.stderr.splitlines()[-15:]))
            return
        results[mode] = json.loads(line[len("BENCH_JSON "):])
        _print_condition(results[mode])

    py, nat = results["python"], results["native"]
    print("\n" + "=" * 60)
    print(f"  end-to-end optimizer wall speedup : {py['wall_s'] / nat['wall_s']:5.2f}x")
    if py["us_per_candidate"] and nat["us_per_candidate"]:
        print(f"  per-candidate speedup (C vs Py)   : {py['us_per_candidate'] / nat['us_per_candidate']:5.2f}x")
    print("=" * 60)
    print("\nNext: add a Numba kernel as a third mode and compare us/candidate.")


if __name__ == "__main__":
    main()
