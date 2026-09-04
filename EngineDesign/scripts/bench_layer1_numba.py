#!/usr/bin/env python3
"""Three-way Layer-1 optimizer benchmark: plain Python vs C vs Numba.

Same harness as bench_layer1_native_vs_python.py (serial in-process, subprocess per
condition, warmup discarded), with a third mode that patches native_injector.evaluate
to the Numba core (numba_eval.make_native_signature_evaluate) — Numba does the
chamber+nozzle+thrust physics, the C diagnostic injector solve + Python stability tail
is identical to the C mode, so the only difference is the chamber-solve core.

Run: .venv/bin/python scripts/bench_layer1_numba.py --max-iterations 8
"""
from __future__ import annotations
import argparse, copy, json, os, subprocess, sys, time
from statistics import median
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "scripts"))


class _C:
    def reset(self):
        self.native_calls = self.native_none = self.runner_calls = 0
C = _C(); C.reset()


def _install_instrumentation():
    from engine.native.python import native_injector as ni
    from engine.core.runner import PintleEngineRunner
    if getattr(ni.evaluate, "_benched", False):
        return
    _on, _or = ni.evaluate, PintleEngineRunner.evaluate
    def nev(*a, **k):
        r = _on(*a, **k); C.native_calls += 1
        if r is None: C.native_none += 1
        return r
    def rev(self, *a, **k):
        C.runner_calls += 1; return _or(self, *a, **k)
    nev._benched = True
    ni.evaluate = nev; PintleEngineRunner.evaluate = rev


def _one(cfg_path, max_it, restarts, seed):
    import numpy as np
    import engine.optimizer.layers.layer1_static_optimization as L1
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.io import load_config
    L1._get_num_workers = lambda cfg: 1
    base = load_config(str(cfg_path)); cfg = copy.deepcopy(base)
    req = cfg.design_requirements.model_dump()
    pcfg = {"mode": "optimizer_controlled",
            "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
            "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"])}
    # Layer 1 draws its CMA seed base from np.random.SeedSequence().entropy (fresh OS
    # entropy) unless requirements["layer1_random_seed"] is pinned -- np.random.seed()
    # only touches the legacy global RandomState and does NOT reach it. Without this pin
    # every run walks a different candidate trajectory and the modes are not comparable.
    req["layer1_random_seed"] = int(seed)
    np.random.seed(seed); t0 = time.perf_counter()
    L1.run_layer1_optimization(cfg, PintleEngineRunner(copy.deepcopy(base)), req,
        target_burn_time=float(req.get("target_burn_time", 6.0)),
        tolerances={"thrust": 0.10, "apogee": 0.15}, pressure_config=pcfg,
        layer1_smoke=True, layer1_max_iterations=int(max_it), layer1_cma_restarts=int(restarts))
    return time.perf_counter() - t0


def _run_condition(mode, cfg_path, max_it, restarts, seed):
    if mode == "python":
        os.environ["ED_USE_NATIVE"] = "0"; os.environ["ED_LAYER1_NATIVE_EVAL"] = "0"
    else:
        os.environ["ED_USE_NATIVE"] = "1"; os.environ["ED_LAYER1_NATIVE_EVAL"] = "1"
    if mode == "numba":
        from engine import accel
        from engine.native.python import native_injector as ni
        ni.evaluate = accel.evaluate  # patch BEFORE instrumentation
    _install_instrumentation()
    _one(cfg_path, 1, 1, seed)     # warmup (JIT compile, CEA load) — discarded
    C.reset()
    wall = _one(cfg_path, max_it, restarts, seed)
    cands = C.native_calls if C.native_calls else C.runner_calls
    out = {"mode": mode, "wall_s": wall, "candidates": cands,
           "native_calls": C.native_calls, "native_fallbacks": C.native_none,
           "runner_calls": C.runner_calls,
           "us_per_candidate": (wall / cands * 1e6) if cands else None}
    print("BENCH_JSON " + json.dumps(out))


def _pc(mode, runs):
    """Summarise N repetitions of one mode.

    A single wall time is not a measurement here: on a loaded box the SAME work
    (seed pinned, byte-identical candidate trajectory) was observed to vary
    6.81s..11.59s, a 1.7x spread that dwarfs the C-vs-Numba difference. Report
    min (least interference) and median instead.
    """
    us = sorted(r["us_per_candidate"] for r in runs)
    walls = sorted(r["wall_s"] for r in runs)
    o = runs[0]
    print(f"\n[{mode.upper()}]  reps={len(runs)}  candidates={o['candidates']}")
    print(f"   wall_s        min={walls[0]:.3f}  median={median(walls):.3f}  max={walls[-1]:.3f}")
    print(f"   us/candidate  min={us[0]:.0f}  median={median(us):.0f}  max={us[-1]:.0f}")
    if o["native_calls"]:
        went = o["native_calls"] - o["native_fallbacks"]
        print(f"   accel path: {went}/{o['native_calls']} ({100.0*went/o['native_calls']:.0f}%)"
              f"  fallback={o['native_fallbacks']}  runner.evaluate={o['runner_calls']}")
    # The seed is pinned, so every rep must do byte-identical work. If it does
    # not, the trajectory is diverging run-to-run and NO comparison here means
    # anything -- say so loudly rather than printing a confident ratio.
    if len({(r["candidates"], r["native_fallbacks"], r["runner_calls"]) for r in runs}) > 1:
        print("   !! WORK VARIED ACROSS REPS -- seed not reaching the optimizer;"
              " these numbers are NOT comparable")
    return {"min": us[0], "median": median(us)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="configs/impinging_lox_ch4_8000N.yaml")
    ap.add_argument("--max-iterations", type=int, default=8)
    ap.add_argument("--cma-restarts", type=int, default=1)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--reps", type=int, default=3,
                    help="timed repetitions per accelerated mode (noise control)")
    ap.add_argument("--python-reps", type=int, default=1,
                    help="reps for the Python baseline (~10x slower, 1 is usually enough)")
    ap.add_argument("--mode", choices=["python", "native", "numba"], default=None)
    a = ap.parse_args()
    cfg_path = (ROOT / a.config) if not os.path.isabs(a.config) else Path(a.config)
    if a.mode:
        _run_condition(a.mode, cfg_path, a.max_iterations, a.cma_restarts, a.seed); return
    print(f"config: {cfg_path}\nbudget: max_iterations={a.max_iterations} restarts={a.cma_restarts} "
          f"seed={a.seed} reps={a.reps} (serial, warmup discarded)")
    agg = {}
    for mode in ("python", "native", "numba"):
        runs = []
        for _ in range(a.python_reps if mode == "python" else a.reps):
            cmd = [sys.executable, str(Path(__file__).resolve()), "--config", a.config,
                   "--max-iterations", str(a.max_iterations), "--cma-restarts", str(a.cma_restarts),
                   "--seed", str(a.seed), "--mode", mode]
            p = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True)
            line = next((l for l in p.stdout.splitlines() if l.startswith("BENCH_JSON ")), None)
            if not line:
                print(f"!! {mode} produced no result. stderr tail:\n"
                      + "\n".join(p.stderr.splitlines()[-20:])); return
            runs.append(json.loads(line[len("BENCH_JSON "):]))
        agg[mode] = _pc(mode, runs)
    py, nat, nb = agg["python"], agg["native"], agg["numba"]
    print("\n" + "=" * 68)
    for stat in ("min", "median"):
        print(f"  [{stat:6s}] per-candidate us:  python={py[stat]:.0f}  C={nat[stat]:.0f}  numba={nb[stat]:.0f}")
        print(f"           speedup vs python:  C={py[stat]/nat[stat]:.1f}x  numba={py[stat]/nb[stat]:.1f}x")
        print(f"           numba vs C: {nb[stat]/nat[stat]:.2f}x the C time"
              f"  ({nat[stat]/nb[stat]:.2f}x speed of C)")
    print("=" * 68)


if __name__ == "__main__":
    main()
