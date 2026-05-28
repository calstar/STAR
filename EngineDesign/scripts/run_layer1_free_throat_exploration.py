#!/usr/bin/env python3
"""Layer-1 exploration with A_throat free in a ±fraction band around baseline mm² (not frozen).

Removes ``A_throat_mm2`` from ``frozen_parameters`` for this run only and passes::

    requirements[\"layer1_A_throat_mm2_min\"]
    requirements[\"layer1_A_throat_mm2_max\"]

which Layer 1 applies to design-vector index 0 (see ``layer1_static_optimization``).

Preset matches user exploration defaults:
  target thrust/MR from YAML, W_MOM=300, W_geom_ao_af_momentum=2800,
  fuel ΔP/Pc band [0.50, 1.50].
"""

from __future__ import annotations

import argparse
import copy
import math
import sys
from pathlib import Path
from typing import Any, Dict

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


def _injector_dp_ratios(perf: Dict[str, Any]) -> tuple[float, float]:
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


def _feasibility_notes(
    perf: Dict[str, Any],
    *,
    o_band: tuple[float, float],
    f_max: float,
) -> str:
    F = float(perf.get("F", float("nan")))
    MR = float(perf.get("MR", float("nan")))
    R = perf.get("momentum_ratio_R")
    R = float(R) if R is not None else float("nan")
    ro, rf = _injector_dp_ratios(perf)

    lines = []
    ok_f = abs(F - 8000.0) / 8000.0 <= 0.05 if math.isfinite(F) else False
    ok_mr = abs(MR - 3.5) / 3.5 <= 0.05 if math.isfinite(MR) else False
    ok_r = abs(R - 1.0) <= 0.10 if math.isfinite(R) else False
    ok_o = o_band[0] <= ro <= o_band[1] if math.isfinite(ro) else False
    ok_ff = rf <= f_max if math.isfinite(rf) else False

    lines.append(f"  thrust near 8000 N (≤5%):     {'YES' if ok_f else 'NO'}  (F={F:.2f})")
    lines.append(f"  MR near 3.5 (≤5%):           {'YES' if ok_mr else 'NO'}  (MR={MR:.4f})")
    lines.append(f"  R near 1 (|R−1|≤10%):       {'YES' if ok_r else 'NO'}  (R={R:.4f})")
    lines.append(
        f"  LOX ΔP/Pc ∈ [{o_band[0]}, {o_band[1]}]:  {'YES' if ok_o else 'NO'}  ({ro:.4f})"
    )
    lines.append(f"  fuel ΔP/Pc ≤ {f_max}:          {'YES' if ok_ff else 'NO'}  ({rf:.4f})")

    all_ok = ok_f and ok_mr and ok_r and ok_o and ok_ff
    lines.insert(0, f"\nJoint feasibility (all YES): {'YES' if all_ok else 'NO'}\n")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=str, default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))
    ap.add_argument("--a-throat-center-mm2", type=float, default=2443.263433372886)
    ap.add_argument(
        "--throat-span-fraction",
        type=float,
        default=0.125,
        help="Symmetric ± fraction (default 0.125 ⇒ ±12.5%, within ~10–15%%)",
    )
    ap.add_argument("--layer1-max-iterations", type=int, default=150)
    ap.add_argument("--layer1-cma-restarts", type=int, default=1)
    ap.add_argument("--w-mom", type=float, default=300.0)
    ap.add_argument("--w-geom-ao-af", type=float, default=2800.0)
    args = ap.parse_args()

    cfg = load_config(args.config)
    req = cfg.design_requirements.model_dump()
    _clean_frozen(req)

    center = float(args.a_throat_center_mm2)
    frac = float(args.throat_span_fraction)
    req["layer1_A_throat_mm2_min"] = center * (1.0 - frac)
    req["layer1_A_throat_mm2_max"] = center * (1.0 + frac)

    req["W_MOM"] = float(args.w_mom)
    req["W_geom_ao_af_momentum"] = float(args.w_geom_ao_af)
    req["injector_dp_ratio_F_min"] = 0.5
    req["injector_dp_ratio_F_max"] = 1.5

    o_band = (float(req["injector_dp_ratio_O_min"]), float(req["injector_dp_ratio_O_max"]))

    pcfg = {
        "mode": "optimizer_controlled",
        "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
        "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"]),
    }

    print(
        "\n=== Free-throat Layer-1 exploration ===\n"
        f"A_throat band [mm²]: [{req['layer1_A_throat_mm2_min']:.6f}, {req['layer1_A_throat_mm2_max']:.6f}] "
        f"(±{100 * frac:.2f}% around {center:.6f})\n"
        f"Frozen params: A_throat removed; other frozen_* from YAML unchanged.\n"
        f"W_MOM={req['W_MOM']}  W_geom_ao_af={req['W_geom_ao_af_momentum']}\n"
        f"Fuel ΔP/Pc ∈ [{req['injector_dp_ratio_F_min']}, {req['injector_dp_ratio_F_max']}]\n"
        f"LOX ΔP/Pc ∈ [{o_band[0]}, {o_band[1]}]\n"
        f"Iterations={args.layer1_max_iterations}  restarts={args.layer1_cma_restarts}\n"
    )

    opt_cfg, results = run_layer1_optimization(
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
    ro, rf = _injector_dp_ratios(perf)

    cg = getattr(opt_cfg, "chamber_geometry", None) or getattr(opt_cfg, "chamber", None)
    a_throat_m2 = getattr(cg, "A_throat", None) if cg is not None else None
    a_throat_mm2 = float(a_throat_m2) * 1e6 if a_throat_m2 is not None else float("nan")

    ig = opt_cfg.injector.geometry
    print("\n=== Results ===")
    print(f"A_throat [mm²]:        {a_throat_mm2:.6f}")
    print(f"Thrust F [N]:          {perf.get('F')}")
    print(f"MR:                    {perf.get('MR')}")
    print(f"momentum_ratio_R:      {perf.get('momentum_ratio_R')}")
    print(f"ΔP_inj_O / Pc:         {ro}")
    print(f"ΔP_inj_F / Pc:         {rf}")
    print(f"P_O_start_psi:         {perf.get('P_O_start_psi')}")
    print(f"P_F_start_psi:         {perf.get('P_F_start_psi')}")
    diagp = perf.get("diagnostics") or {}
    ae_o = perf.get("A_eff_O", diagp.get("A_eff_O"))
    ae_f = perf.get("A_eff_F", diagp.get("A_eff_F"))
    print(f"A_geom_O / A_geom_F:   {perf.get('geom_ao_af')}")
    print(f"A_eff_O / A_eff_F:     {ae_o} / {ae_f}  → ratio {_aeff_ratio_from(ae_o, ae_f)}")
    print(
        f"Injector: n_O={int(ig.oxidizer.n_elements)} d_O={ig.oxidizer.d_jet*1000:.4f} mm  "
        f"sp_O={ig.oxidizer.spacing*1000:.3f} mm | "
        f"n_F={int(ig.fuel.n_elements)} d_F={ig.fuel.d_jet*1000:.4f} mm  "
        f"sp_F={ig.fuel.spacing*1000:.3f} mm"
    )

    print(_feasibility_notes(perf, o_band=o_band, f_max=float(req["injector_dp_ratio_F_max"])))


def _aeff_ratio_from(ae: Any, af: Any) -> float:
    try:
        if ae is not None and af is not None and float(af) > 0:
            return float(ae) / float(af)
    except (TypeError, ValueError):
        pass
    return float("nan")


if __name__ == "__main__":
    main()
