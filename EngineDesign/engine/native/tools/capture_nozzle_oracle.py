"""Phase 0 — parity oracle + baseline for the C nozzle/evaluate port.

Captures the PURE-PYTHON ``runner.evaluate()`` results (the ground truth the C
``ed_nozzle``/``ed_evaluate`` port is checked against) for the canonical pintle and
impinging engines at several tank-pressure points, and:

  * dumps a golden JSON (engine/native/tests/golden/nozzle_oracle.json),
  * measures the shifting-equilibrium vs frozen (chamber-gamma) delta on F/Isp so we
    can decide whether the C nozzle must port shifting equilibrium or can stay frozen
    within the rtol=1e-3 parity tolerance,
  * reports baseline per-evaluate timing.

Run:  .venv/bin/python -m engine.native.tools.capture_nozzle_oracle
The oracle is the Python path, so we FORCE ED_USE_NATIVE=0 before importing engine code.
"""

from __future__ import annotations

import os

# Ground truth = Python physics. Must be set before engine imports resolve native dispatch.
os.environ["ED_USE_NATIVE"] = "0"

import copy
import json
import time
from pathlib import Path

from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner

PSI_TO_PA = 6894.76
REPO = Path(__file__).resolve().parents[3]  # .../EngineDesign
GOLDEN = REPO / "engine" / "native" / "tests" / "golden" / "nozzle_oracle.json"

# Fields the Layer-1 objective + EdEvaluateResult care about (see ed_evaluate.h).
RESULT_KEYS = [
    "F", "Isp", "Pc", "MR", "v_exit", "P_exit", "P_throat", "T_exit", "T_throat",
    "Cf_actual", "Cf_ideal",
]
DIAG_KEYS = [
    "cstar_actual", "cstar_ideal", "eta_cstar", "mdot_O", "mdot_F", "MR",
    "gamma", "R", "Tc", "momentum_ratio_R", "Cd_O", "Cd_F", "SMD",
]

CASES = [
    # (label, config_path, P_O_psi, P_F_psi) — nominals from each config's tank initial_pressure_psi
    ("pintle", "configs/canonical/pintle.yaml", 523.6759162449396, 537.261547029532),
    ("impinging", "configs/canonical/impinging.yaml", 563.4671262691785, 567.6435444099167),
]
# Perturbation multipliers applied to the nominal (P_O, P_F) to exercise the nozzle off-design.
PERTURB = [(1.00, 1.00), (0.92, 0.97), (1.06, 1.03)]


def _extract(result: dict) -> dict:
    diag = result.get("diagnostics", {}) or {}
    out = {k: _num(result.get(k)) for k in RESULT_KEYS}
    out["diagnostics"] = {k: _num(diag.get(k)) for k in DIAG_KEYS}
    return out


def _num(v):
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _set_shifting(config, enabled: bool) -> None:
    eff = getattr(getattr(config, "combustion", None), "efficiency", None)
    if eff is not None and hasattr(eff, "use_shifting_equilibrium"):
        eff.use_shifting_equilibrium = enabled


def _rel(a, b) -> float:
    if a is None or b is None:
        return float("nan")
    return abs(a - b) / max(abs(b), 1e-12)


def main() -> None:
    golden = {"_meta": {"oracle": "python runner.evaluate (ED_USE_NATIVE=0)",
                        "rtol_target": 1e-3}, "cases": []}
    print(f"{'case':>22} {'shift?':>6} {'F (N)':>12} {'Isp (s)':>9} {'Pc (bar)':>9}")
    for label, rel_path, p_o_psi, p_f_psi in CASES:
        config = load_config(REPO / rel_path)
        runner = PintleEngineRunner(config)
        p_amb = 101325.0
        for i, (mo, mf) in enumerate(PERTURB):
            p_o = p_o_psi * mo * PSI_TO_PA
            p_f = p_f_psi * mf * PSI_TO_PA
            point = {"case": label, "config": rel_path, "P_O_Pa": p_o, "P_F_Pa": p_f,
                     "P_ambient_Pa": p_amb}
            for shift in (True, False):
                _set_shifting(runner.config, shift)
                try:
                    res = runner.evaluate(p_o, p_f, P_ambient=p_amb, silent=True)
                    rec = _extract(res)
                    err = None
                except Exception as e:  # capture failures too — they're part of the contract
                    rec, err = None, f"{type(e).__name__}: {e}"
                key = "shifting" if shift else "frozen"
                point[key] = {"result": rec, "error": err}
                if rec:
                    print(f"{label+'['+str(i)+']':>22} {key:>6} "
                          f"{rec['F']:>12.2f} {rec['Isp']:>9.2f} {rec['Pc']/1e5:>9.2f}")
                else:
                    print(f"{label+'['+str(i)+']':>22} {key:>6}  ERROR: {err}")
            # shifting-vs-frozen delta (decides C nozzle scope)
            s, f = point["shifting"].get("result"), point["frozen"].get("result")
            if s and f:
                point["shift_delta"] = {
                    "F_rel": _rel(s["F"], f["F"]),
                    "Isp_rel": _rel(s["Isp"], f["Isp"]),
                    "P_exit_rel": _rel(s["P_exit"], f["P_exit"]),
                }
            golden["cases"].append(point)

    # Baseline timing on the nominal pintle point (shifting on, the production default).
    config = load_config(REPO / CASES[0][1])
    runner = PintleEngineRunner(config)
    _set_shifting(runner.config, True)
    p_o, p_f = CASES[0][2] * PSI_TO_PA, CASES[0][3] * PSI_TO_PA
    runner.evaluate(p_o, p_f, P_ambient=101325.0, silent=True)  # warm
    N = 200
    t0 = time.perf_counter()
    for _ in range(N):
        runner.evaluate(p_o, p_f, P_ambient=101325.0, silent=True)
    per_ms = (time.perf_counter() - t0) / N * 1e3
    golden["_meta"]["python_evaluate_ms"] = per_ms

    GOLDEN.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=2))

    # Summary: worst-case shifting delta across all points.
    deltas = [c["shift_delta"] for c in golden["cases"] if "shift_delta" in c]
    if deltas:
        worst_F = max(d["F_rel"] for d in deltas)
        worst_Isp = max(d["Isp_rel"] for d in deltas)
        print("\n--- shifting-equilibrium impact (decides C nozzle scope) ---")
        print(f"worst |dF|/F   across points: {worst_F:.2e}")
        print(f"worst |dIsp|/Isp:              {worst_Isp:.2e}")
        print(f"parity target rtol:            {1e-3:.0e}")
        verdict = ("FROZEN nozzle is WITHIN tolerance — C port can skip shifting equilibrium"
                   if max(worst_F, worst_Isp) < 1e-3 else
                   "shifting equilibrium EXCEEDS tolerance — C nozzle MUST port it")
        print(f"verdict: {verdict}")
    print(f"\nbaseline python evaluate: {per_ms:.3f} ms/call")
    print(f"golden written: {GOLDEN.relative_to(REPO)}")


if __name__ == "__main__":
    main()
