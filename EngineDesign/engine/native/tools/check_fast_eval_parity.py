"""Manual A/B check + timing — native_injector.evaluate() vs runner.evaluate().

Both paths now compute the same RPA delivered thrust (the old frozen-vs-shifting
distinction is gone; the shifting nozzle was retired), so this is a plain live
parity sweep plus a per-call timing comparison. The pytest version of this check
is tests/test_native_ab_parity.py (run in the CI parity job); this script remains
for interactive use because it prints per-field tables and the speedup number.

Run:  .venv/bin/python -m engine.native.tools.check_fast_eval_parity
"""

from __future__ import annotations

import os

os.environ["ED_USE_NATIVE"] = "1"

import time
from pathlib import Path

from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner
from engine.native.python import native_injector as ni

REPO = Path(__file__).resolve().parents[3]
PA = 101325.0
POINTS = [(563.467, 567.644), (518.4, 550.6), (597.3, 584.7)]  # psi (O, F)

TOP = ["F", "Isp", "Pc", "MR", "Cf_actual", "P_exit", "T_exit", "v_exit"]
DIAG = ["mdot_O", "mdot_F", "D32_O", "D32_F", "delta_p_feed_O", "delta_p_feed_F",
        "Cd_O", "Cd_F", "momentum_ratio_R", "impingement_angle_deg"]


def _stab_margins(s):
    return {
        "state": s.get("stability_state", "?"),
        "score": float(s.get("stability_score", 0.0)),
        "chug": float(s.get("chugging", {}).get("stability_margin", 0.0)),
        "acoustic": float(s.get("acoustic", {}).get("stability_margin", 0.0)),
        "feed": float(s.get("feed_system", {}).get("stability_margin", 0.0)),
    }


def main() -> int:
    config = load_config(REPO / "configs/canonical/impinging.yaml")
    runner = PintleEngineRunner(config)
    worst = 0.0
    fails = 0
    for po_psi, pf_psi in POINTS:
        p_o, p_f = po_psi * 6894.76, pf_psi * 6894.76
        ref = runner.evaluate(p_o, p_f, P_ambient=PA, silent=True)
        nat = ni.evaluate(config, runner.cea_cache, p_o, p_f, PA)
        if nat is None:
            print(f"  [FAIL] native returned None at ({po_psi},{pf_psi})")
            fails += 1
            continue
        print(f"\npoint O={po_psi} F={pf_psi} psi")
        for k in TOP:
            fails, worst = _cmp(k, nat.get(k), ref.get(k), fails, worst)
        rd, nd = ref.get("diagnostics", {}), nat.get("diagnostics", {})
        for k in DIAG:
            fails, worst = _cmp("diag." + k, nd.get(k), rd.get(k), fails, worst)
        rs, ns = _stab_margins(ref.get("stability_results", {})), _stab_margins(nat.get("stability_results", {}))
        same_state = rs["state"] == ns["state"]
        print(f"  {'stab.state':>20}: native={ns['state']} ref={rs['state']} "
              f"{'ok' if same_state else 'FAIL'}")
        if not same_state:
            fails += 1
        for k in ("score", "chug", "acoustic", "feed"):
            fails, worst = _cmp("stab." + k, ns[k], rs[k], fails, worst)

    # timing: native fast path vs production runner.evaluate
    p_o, p_f = POINTS[0][0] * 6894.76, POINTS[0][1] * 6894.76
    t_prod = _time(lambda: runner.evaluate(p_o, p_f, P_ambient=PA, silent=True))
    t_fast = _time(lambda: ni.evaluate(config, runner.cea_cache, p_o, p_f, PA))
    print(f"\n=== {fails} failures, worst rel = {worst:.2e} (live native-vs-Python parity) ===")
    print(f"timing: production runner.evaluate = {t_prod*1e6:7.1f} us/call")
    print(f"        native_injector.evaluate   = {t_fast*1e6:7.1f} us/call")
    print(f"        speedup                     = {t_prod/t_fast:.2f}x")
    return 1 if fails else 0


def _time(fn, n=400):
    fn()
    t0 = time.perf_counter()
    for _ in range(n):
        fn()
    return (time.perf_counter() - t0) / n


def _cmp(name, got, want, fails, worst):
    if want is None and got is None:
        return fails, worst
    if got is None or want is None:
        print(f"  {name:>20}: got={got} want={want}  [MISSING]")
        return fails + 1, worst
    rel = abs(got - want) / max(abs(want), 1e-12)
    worst = max(worst, rel)
    flag = "FAIL" if rel > 1e-3 else "ok"
    if flag == "FAIL":
        fails += 1
    print(f"  {name:>20}: native={got:13.6g} ref={want:13.6g}  rel={rel:.2e}  {flag}")
    return fails, worst


if __name__ == "__main__":
    raise SystemExit(main())
