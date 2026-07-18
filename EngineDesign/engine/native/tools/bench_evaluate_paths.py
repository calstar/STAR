"""Decompose the Layer-1 evaluate cost to scope the ed_evaluate wiring (Phase 4).

Times, on the impinging canonical engine, with the native kernel ENABLED (the real
production inner-loop setting):
  1. runner.evaluate()            — current production per-candidate path
  2. native ed_evaluate() alone   — chamber + frozen nozzle, one C call, no stability
  3. comprehensive_stability_analysis() alone — the Python stability the objective needs

Phase-4 native path ≈ (2) + (3), since the objective scores stability per candidate.
This tells us whether bypassing runner.evaluate with ed_evaluate is worth the surgery.

Run:  .venv/bin/python -m engine.native.tools.bench_evaluate_paths
"""

from __future__ import annotations

import os

os.environ["ED_USE_NATIVE"] = "1"

import ctypes as C
import time
from pathlib import Path

from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner
from engine.native.python import native_injector as ni

REPO = Path(__file__).resolve().parents[3]
PA = 101325.0
P_O = 563.4671262691785 * 6894.76
P_F = 567.6435444099167 * 6894.76


def _time(fn, n):
    fn()  # warm
    t0 = time.perf_counter()
    for _ in range(n):
        fn()
    return (time.perf_counter() - t0) / n * 1e6  # microseconds


def main() -> None:
    config = load_config(REPO / "configs/canonical/impinging.yaml")
    runner = PintleEngineRunner(config)
    N = 400

    # 1. production runner.evaluate (native chamber + python nozzle/shifting + stability)
    t_runner = _time(lambda: runner.evaluate(P_O, P_F, P_ambient=PA, silent=True), N)

    # 2. native ed_evaluate alone
    st = ni.build_state(config)
    nat = ni._nat()
    ni._ensure_cea(runner.cea_cache)
    def _native():
        rc, res = nat.evaluate(C.byref(st), P_O, P_F, PA)
        return res
    t_native = _time(_native, N)

    # 3. comprehensive_stability_analysis alone (needs a diagnostics dict)
    res = runner.evaluate(P_O, P_F, P_ambient=PA, silent=True)
    diag = res["diagnostics"]
    from engine.pipeline.stability.analysis import comprehensive_stability_analysis
    def _stab():
        return comprehensive_stability_analysis(
            config=config, Pc=res["Pc"], MR=res["MR"], mdot_total=diag["mdot_O"] + diag["mdot_F"],
            cstar=res["cstar_actual"], gamma=res["gamma"], R=res["R"], Tc=res["Tc"], diagnostics=diag)
    t_stab = _time(_stab, N)

    print(f"\n{'path':<46} {'us/call':>10}")
    print(f"{'1. runner.evaluate (production today)':<46} {t_runner:>10.1f}")
    print(f"{'2. native ed_evaluate (chamber+frozen nozzle)':<46} {t_native:>10.1f}")
    print(f"{'3. comprehensive_stability_analysis':<46} {t_stab:>10.1f}")
    print(f"{'   => Phase-4 native path est (2 + 3)':<46} {t_native + t_stab:>10.1f}")
    if t_runner > 0:
        print(f"\nrunner.evaluate breakdown: stability is ~{100*t_stab/t_runner:.0f}% of it")
        print(f"projected speedup of (2+3) vs (1): {t_runner/(t_native+t_stab):.2f}x")
        print(f"projected speedup if stability stays as-is and only physics swaps: "
              f"{t_runner/(t_native+t_stab):.2f}x (stability dominates → limited)")


if __name__ == "__main__":
    main()
