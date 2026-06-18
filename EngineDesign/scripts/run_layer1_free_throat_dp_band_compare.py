#!/usr/bin/env python3
"""Free-throat Layer-1 with two methane ΔP/Pc band scenarios vs updated LOX band.

Scenario A — matches YAML defaults after update:
  LOX [0.15, 0.40], CH4 [0.15, 0.40]

Scenario B — relaxed methane only:
  LOX [0.15, 0.40], CH4 [0.20, 0.50]

Reports whether optimum satisfies (approximate gates):
  |F−8000|/8000 ≤ 5%, |MR−3.5|/3.5 ≤ 5%, |R−1| ≤ 10%,
  both ΔP_inj/Pc streams inside the scenario bands.
"""

from __future__ import annotations

import argparse
import copy
import math
import sys
from pathlib import Path
from typing import Any, Dict, Tuple

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402


def _clean_frozen(req: Dict[str, Any]) -> None:
    fp = req.get("frozen_parameters")
    if not isinstance(fp, dict):
        fp = {}
    else:
        fp = {k: v for k, v in fp.items() if v is not None}
    fp.pop("A_throat_mm2", None)
    req["frozen_parameters"] = fp


def _dp_ratios(perf: Dict[str, Any]) -> Tuple[float, float]:
    ro = perf.get("injector_dp_ratio_O")
    rf = perf.get("injector_dp_ratio_F")
    if ro is not None and rf is not None:
        return float(ro), float(rf)
    diag = perf.get("diagnostics") or {}
    pc = float(perf.get("Pc", float("nan")))
    dpo = diag.get("delta_p_injector_O")
    dpf = diag.get("delta_p_injector_F")
    ro_v = float(dpo) / pc if dpo is not None and pc > 0 else float("nan")
    rf_v = float(dpf) / pc if dpf is not None and pc > 0 else float("nan")
    return ro_v, rf_v


def _sf(x: Any) -> float:
    try:
        if x is None:
            return float("nan")
        v = float(x)
        return v if math.isfinite(v) else float("nan")
    except (TypeError, ValueError):
        return float("nan")


def _report(
    name: str,
    perf: Dict[str, Any],
    *,
    o_band: Tuple[float, float],
    f_band: Tuple[float, float],
) -> None:
    F = _sf(perf.get("F"))
    MR = _sf(perf.get("MR"))
    R = _sf(perf.get("momentum_ratio_R"))
    ro, rf = _dp_ratios(perf)

    ok_f = abs(F - 8000.0) / 8000.0 <= 0.05 if math.isfinite(F) else False
    ok_mr = abs(MR - 3.5) / 3.5 <= 0.05 if math.isfinite(MR) else False
    ok_r = abs(R - 1.0) <= 0.10 if math.isfinite(R) else False
    ok_o = o_band[0] <= ro <= o_band[1] if math.isfinite(ro) else False
    ok_ff = f_band[0] <= rf <= f_band[1] if math.isfinite(rf) else False
    joint = ok_f and ok_mr and ok_r and ok_o and ok_ff

    print(f"\n{'=' * 72}\n{name}\n{'=' * 72}")
    print(f"F [N]: {F:.4g}    MR: {MR:.6g}    R: {R:.6g}")
    print(f"ΔP_O/Pc: {ro:.6g}   (band [{o_band[0]}, {o_band[1]}])   OK={ok_o}")
    print(f"ΔP_F/Pc: {rf:.6g}   (band [{f_band[0]}, {f_band[1]}])   OK={ok_ff}")
    print(f"P_O_psi: {perf.get('P_O_start_psi')}   P_F_psi: {perf.get('P_F_start_psi')}")
    print(
        f"Gates: thrust≤5% {ok_f}  MR≤5% {ok_mr}  R≤10% {ok_r}  "
        f"LOX band {ok_o}  CH4 band {ok_ff}"
    )
    print(f"\n** Joint target satisfaction (all gates): {'YES' if joint else 'NO'} **")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=str, default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))
    ap.add_argument("--a-throat-center-mm2", type=float, default=2443.263433372886)
    ap.add_argument("--throat-span-fraction", type=float, default=0.125)
    ap.add_argument("--layer1-max-iterations", type=int, default=130)
    ap.add_argument("--layer1-cma-restarts", type=int, default=1)
    args = ap.parse_args()

    cfg_path = Path(args.config)
    center = float(args.a_throat_center_mm2)
    frac = float(args.throat_span_fraction)

    scenarios = [
        (
            "A: LOX & CH4 [0.15, 0.40]",
            (0.15, 0.40),
            (0.15, 0.40),
        ),
        (
            "B: LOX [0.15, 0.40], CH4 [0.20, 0.50]",
            (0.15, 0.40),
            (0.20, 0.50),
        ),
    ]

    print(
        "\nFree-throat Layer-1 ΔP band comparison\n"
        f"  throat span ±{100 * frac:.2f}% around {center:.4f} mm²\n"
        f"  iterations={args.layer1_max_iterations}  restarts={args.layer1_cma_restarts}\n"
        "  W_MOM=300  W_geom_ao_af_momentum=2800\n"
    )

    for scen_name, o_band, f_band in scenarios:
        cfg = load_config(str(cfg_path))
        req = cfg.design_requirements.model_dump()
        _clean_frozen(req)

        req["layer1_A_throat_mm2_min"] = center * (1.0 - frac)
        req["layer1_A_throat_mm2_max"] = center * (1.0 + frac)

        req["injector_dp_ratio_O_min"] = o_band[0]
        req["injector_dp_ratio_O_max"] = o_band[1]
        req["injector_dp_ratio_F_min"] = f_band[0]
        req["injector_dp_ratio_F_max"] = f_band[1]

        req["W_MOM"] = 300.0
        req["W_geom_ao_af_momentum"] = 2800.0

        pcfg = {
            "mode": "optimizer_controlled",
            "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
            "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"]),
        }

        _, results = run_layer1_optimization(
            copy.deepcopy(cfg),
            PintleEngineRunner(copy.deepcopy(cfg)),
            req,
            target_burn_time=float(req.get("target_burn_time", 6.0)),
            tolerances={"thrust": 0.10, "apogee": 0.15},
            pressure_config=pcfg,
            layer1_smoke=False,
            layer1_max_iterations=int(args.layer1_max_iterations),
            layer1_cma_restarts=int(args.layer1_cma_restarts),
        )
        perf = results.get("performance") or {}
        _report(scen_name, perf, o_band=o_band, f_band=f_band)


if __name__ == "__main__":
    main()
