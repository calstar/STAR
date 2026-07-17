"""Phase 2 validation — native ed_evaluate vs the stored frozen Python oracle.

Drives the REAL ctypes path: build_state(config) -> EdNative.evaluate() (full C
chain: chamber solve -> CEA -> frozen nozzle -> EdEvaluateResult) and compares to
the FROZEN branch of tests/golden/nozzle_oracle.json (captured pure-Python in
Phase 0). Impinging only — build_state currently supports impinging geometry; the
pintle config falls back to the Python path in production (and is unaffected here).

Set ED_NATIVE_LIB to the freshly built libed_physics so we test current C, not a
stale prebuilt dylib. Run:

  ED_NATIVE_LIB=engine/native/build_phase1/libed_physics.dylib \
    .venv/bin/python -m engine.native.tools.check_evaluate_parity
"""

from __future__ import annotations

import os

os.environ["ED_USE_NATIVE"] = "1"  # enable the native helpers; we call C directly.

import ctypes as C
import json
from pathlib import Path

from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner
from engine.native.python import native_injector as ni

REPO = Path(__file__).resolve().parents[3]
ORACLE = json.loads((REPO / "engine/native/tests/golden/nozzle_oracle.json").read_text())

TOP = ["F", "Isp", "Pc", "MR", "v_exit", "P_exit", "P_throat", "T_exit", "T_throat",
       "Cf_actual", "Cf_ideal"]
DIAG = ["cstar_actual", "cstar_ideal", "eta_cstar", "mdot_O", "mdot_F", "gamma", "R",
        "momentum_ratio_R", "Cd_O", "Cd_F", "SMD"]
RTOL = 2e-3  # program parity target (chamber native↔python lands within ~1e-3)


def main() -> int:
    config = load_config(REPO / "configs/canonical/impinging.yaml")
    runner = PintleEngineRunner(config)
    if not ni._can_handle_chamber(config):
        print("FAIL: native cannot handle the impinging canonical config")
        return 1
    st = ni.build_state(config)
    nat = ni._nat()
    if not ni._ensure_cea(runner.cea_cache):
        print("FAIL: could not load CEA into native lib (cache not 3D?)")
        return 1
    print(f"native lib: {nat.lib_path}")

    worst = 0.0
    fails = 0
    n = 0
    for pt in ORACLE["cases"]:
        if pt["case"] != "impinging":
            continue
        fr = pt["frozen"]["result"]
        if fr is None:
            continue
        rc, res = nat.evaluate(C.byref(st), pt["P_O_Pa"], pt["P_F_Pa"], pt["P_ambient_Pa"])
        if rc != 0 or not res.converged:
            print(f"  [FAIL] point {n}: native rc={rc} converged={res.converged}")
            fails += 1
            n += 1
            continue
        print(f"\npoint {n}  P_O={pt['P_O_Pa']/6894.76:.1f}psi  P_F={pt['P_F_Pa']/6894.76:.1f}psi")
        diag = fr.get("diagnostics", {})
        for k in TOP:
            fails, worst = _cmp(k, getattr(res, k), fr.get(k), fails, worst)
        for k in DIAG:
            fails, worst = _cmp(k, getattr(res, k), diag.get(k), fails, worst)
        n += 1

    print(f"\n=== {n} impinging points, {fails} failures, worst rel = {worst:.2e} "
          f"(target rtol {RTOL:.0e}) ===")
    return 1 if (fails or n == 0) else 0


def _cmp(name, got, want, fails, worst):
    if want is None:
        return fails, worst
    rel = abs(got - want) / max(abs(want), 1e-12)
    worst = max(worst, rel)
    flag = "FAIL" if rel > RTOL else "ok"
    if flag == "FAIL":
        fails += 1
    print(f"  {name:>16} got={got:14.6g} want={want:14.6g}  rel={rel:.2e}  {flag}")
    return fails, worst


if __name__ == "__main__":
    raise SystemExit(main())
