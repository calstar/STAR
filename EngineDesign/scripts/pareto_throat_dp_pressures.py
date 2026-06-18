#!/usr/bin/env python3
"""Pareto-style trade study: throat area × tank-cap philosophy → ΔP/Pc (pressures solved).

Workflow (automates the recommendation: fix feed/tank envelope, sweep throat, *then*
interpret geometry):

1. Load YAML (default ``configs/impinging_lox_ch4_8000N.yaml``); **injector geometry** from
   config (unchanged unless you edit YAML first).
2. For each **tank scenario** ``lox_cap:fuel_cap`` [psi], build Layer-1-style **pressure bounds**
   ``[lo_frac, hi_frac]`` of each cap (defaults 0.62–0.92).
3. **1-D sweep** of ``A_throat`` [mm²] from ``center × (1 ± span)``.
4. For each grid point, **multi-start L-BFGS-B** on ``(P_O, P_F)`` [psi] minimizes
   ``(F/F_target−1)² + (MR/MR_target−1)²``. Optional **differential_evolution** polish if residual
   is still large (``--de-fallback``).
5. Writes ``output/pareto_throat_dp_pressures.csv`` and prints rows + a small **non-dominated**
   set on ``(mission_err, ΔP_F/Pc)`` among near-target points.

**Note:** Only ``chamber_geometry.A_throat`` is updated per row; chamber volume / L* are not
re-solved here—use for **trends** and pressure–throat coupling, not final hardware sign-off.
Exit area is scaled so ``A_exit / A_throat`` stays equal to YAML ``expansion_ratio``.

The pressure objective matches **F** and **MR** only; **momentum ratio R** is diagnostic.
Tune jets using ``feasibility_impinging_lox_ch4_sweep.py`` (or Layer‑1) after picking a throat
and tank-cap envelope from this script.

Examples::

  python scripts/pareto_throat_dp_pressures.py --quick
  python scripts/pareto_throat_dp_pressures.py --tank-scenarios 700:700,700:600,700:500 --n-throat 11
"""

from __future__ import annotations

import argparse
import copy
import csv
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.optimizer.injector_dp_penalty import injector_dp_ratios_from_eval_result  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

PSI_TO_PA = 6894.76


def _parse_tank_scenarios(s: str) -> List[Tuple[float, float]]:
    out: List[Tuple[float, float]] = []
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        if ":" not in part:
            raise ValueError(f"Bad tank scenario {part!r}; use lox_cap:fuel_cap (e.g. 700:600)")
        a, b = part.split(":", 1)
        out.append((float(a.strip()), float(b.strip())))
    if not out:
        raise ValueError("No tank scenarios parsed")
    return out


def _throat_center_mm2(cfg: Any) -> float:
    req = cfg.design_requirements.model_dump()
    fp = req.get("frozen_parameters") or {}
    if isinstance(fp, dict) and fp.get("A_throat_mm2") is not None:
        return float(fp["A_throat_mm2"])
    if cfg.chamber_geometry is not None and cfg.chamber_geometry.A_throat is not None:
        return float(cfg.chamber_geometry.A_throat) * 1.0e6
    raise ValueError("Cannot infer throat center: no frozen A_throat_mm2 or chamber_geometry.A_throat")


def _apply_throat_mm2(cfg: Any, mm2: float) -> None:
    """Set throat area and rescale exit area so ``A_exit/A_throat == expansion_ratio`` (runner consistency check)."""
    if cfg.chamber_geometry is None:
        raise ValueError("config.chamber_geometry is required")
    cg = cfg.chamber_geometry
    At = float(mm2) * 1.0e-6
    eps = float(cg.expansion_ratio)
    Ae = eps * At
    cg.A_throat = At
    cg.A_exit = Ae
    cg.exit_diameter = 2.0 * math.sqrt(max(Ae, 1e-30) / math.pi)
    nozzle = getattr(cfg, "nozzle", None)
    if nozzle is not None:
        nozzle.A_throat = At
        nozzle.A_exit = Ae
        nozzle.expansion_ratio = eps
        ed = getattr(nozzle, "exit_diameter", None)
        if ed is not None:
            nozzle.exit_diameter = float(cg.exit_diameter)


def _row_eval(
    runner: PintleEngineRunner,
    P_O_psi: float,
    P_F_psi: float,
    F_t: float,
    MR_t: float,
) -> Dict[str, Any]:
    try:
        res = runner.evaluate(float(P_O_psi) * PSI_TO_PA, float(P_F_psi) * PSI_TO_PA, silent=True)
    except Exception as e:
        return {"ok": False, "err": f"{type(e).__name__}: {e}"}
    F = float(res.get("F", float("nan")))
    MR = float(res.get("MR", float("nan")))
    pc = float(res.get("Pc", float("nan")))
    if not math.isfinite(F) or not math.isfinite(MR) or not math.isfinite(pc) or pc <= 0:
        return {"ok": False, "err": "nonfinite F/MR/Pc"}
    ro, rf = injector_dp_ratios_from_eval_result(pc, res)
    diag = res.get("diagnostics") if isinstance(res.get("diagnostics"), dict) else {}
    R = diag.get("momentum_ratio_R")
    R_f = float(R) if R is not None and np.isfinite(R) else float("nan")
    m_err = math.hypot(F / F_t - 1.0, MR / MR_t - 1.0)
    rfo = float(ro) if ro is not None and np.isfinite(ro) else float("nan")
    rff = float(rf) if rf is not None and np.isfinite(rf) else float("nan")
    return {
        "ok": True,
        "err": "",
        "F": F,
        "MR": MR,
        "Pc": pc,
        "r_O": rfo,
        "r_F": rff,
        "R": R_f,
        "m_err": m_err,
    }


def _solve_pressures(
    runner: PintleEngineRunner,
    F_t: float,
    MR_t: float,
    b_o: Tuple[float, float],
    b_f: Tuple[float, float],
    *,
    de_fallback: bool,
    de_maxiter: int,
    de_pop: int,
    maxfun_local: int,
    quick_local: bool,
) -> Tuple[Optional[np.ndarray], float, int]:
    from scipy.optimize import differential_evolution, minimize

    lo_o, hi_o = b_o
    lo_f, hi_f = b_f
    bounds = [(lo_o, hi_o), (lo_f, hi_f)]

    nfev = 0

    def objective(xy: np.ndarray) -> float:
        nonlocal nfev
        nfev += 1
        row = _row_eval(runner, float(xy[0]), float(xy[1]), F_t, MR_t)
        if not row["ok"]:
            return 1e12
        F, MR = row["F"], row["MR"]
        return float((F / F_t - 1.0) ** 2 + (MR / MR_t - 1.0) ** 2)

    starts = []
    ro_grid = (0.65, 0.85) if quick_local else (0.65, 0.75, 0.85)
    rf_grid = (0.65, 0.85) if quick_local else (0.65, 0.75, 0.85)
    for r_o in ro_grid:
        for r_f in rf_grid:
            starts.append([lo_o + r_o * (hi_o - lo_o), lo_f + r_f * (hi_f - lo_f)])
    starts.append([(lo_o + hi_o) * 0.5, (lo_f + hi_f) * 0.5])

    best_x: Optional[np.ndarray] = None
    best_fun = 1e12
    fallback_x: Optional[np.ndarray] = None
    fallback_fun = 1e12
    for x0 in starts:
        opt = minimize(
            objective,
            np.asarray(x0, dtype=float),
            method="L-BFGS-B",
            bounds=bounds,
            options={"maxfun": maxfun_local, "ftol": 1e-12},
        )
        xf = np.asarray(opt.x, dtype=float)
        fv = float(opt.fun) if np.isfinite(opt.fun) else 1e12
        if fv < fallback_fun and np.all(np.isfinite(xf)):
            fallback_fun = fv
            fallback_x = xf
        if opt.success and fv < best_fun:
            best_fun = fv
            best_x = xf
        elif fv < best_fun:
            best_fun = fv
            best_x = xf

    if best_x is None and fallback_x is not None:
        best_x = fallback_x
        best_fun = fallback_fun

    # Coarse grid if optimizers never produced a finite iterate (stiff/noisy objective).
    if best_x is None or not np.all(np.isfinite(best_x)):
        gx: Optional[np.ndarray] = None
        gf = 1e12
        for Po in np.linspace(lo_o, hi_o, num=11):
            for Pf in np.linspace(lo_f, hi_f, num=11):
                v = objective(np.asarray([Po, Pf], dtype=float))
                if v < gf:
                    gf = float(v)
                    gx = np.asarray([Po, Pf], dtype=float)
        if gx is not None and gf < 1e11:
            best_x = gx
            best_fun = gf

    if de_fallback and best_fun > 2.5e-3:  # ~5% combined scale trigger
        de = differential_evolution(
            objective,
            bounds,
            maxiter=int(de_maxiter),
            popsize=int(de_pop),
            polish=True,
            seed=42,
            atol=1e-5,
            tol=1e-4,
        )
        if de.fun < best_fun:
            best_fun = float(de.fun)
            best_x = np.asarray(de.x, dtype=float)

    return best_x, best_fun, nfev


def _pareto_nd(
    rows: Sequence[Dict[str, Any]],
    *,
    m_err_cap: float,
) -> List[Dict[str, Any]]:
    """Minimize both m_err and ΔP_F/Pc; keep non-dominated among m_err <= cap."""

    def _rf(row: Dict[str, Any]) -> float:
        v = row.get("dP_F_over_Pc", "")
        if v == "" or v is None:
            return 1e9
        x = float(v)
        return x if math.isfinite(x) else 1e9

    pts = [r for r in rows if r.get("ok") and float(r.get("m_err", 1e9)) <= m_err_cap]
    if not pts:
        return []
    nd: List[Dict[str, Any]] = []
    for i, p in enumerate(pts):
        mi = float(p["m_err"])
        ri = _rf(p)
        dominated = False
        for j, q in enumerate(pts):
            if i == j:
                continue
            mj = float(q["m_err"])
            rj = _rf(q)
            if (mj <= mi and rj <= ri) and (mj < mi or rj < ri):
                dominated = True
                break
        if not dominated:
            nd.append(p)
    nd.sort(key=lambda r: (float(r["m_err"]), _rf(r)))
    return nd


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=str, default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))
    ap.add_argument("--target-F", type=float, default=8000.0)
    ap.add_argument("--target-MR", type=float, default=3.5)
    ap.add_argument(
        "--tank-scenarios",
        type=str,
        default="700:700,700:600,700:500",
        help="Comma-separated lox_cap:fuel_cap [psi] design maxima for pressure bounds",
    )
    ap.add_argument("--p-lo-frac", type=float, default=0.62, help="Lower fraction of cap for P bounds")
    ap.add_argument("--p-hi-frac", type=float, default=0.92, help="Upper fraction of cap for P bounds")
    ap.add_argument("--throat-span", type=float, default=0.125, help="Fractional ± span around center A_throat")
    ap.add_argument("--n-throat", type=int, default=9, help="Number of throat samples (linspace)")
    ap.add_argument("--quick", action="store_true", help="Fewer throat points (5) and no DE fallback")
    ap.add_argument("--de-fallback", action="store_true", help="Run differential_evolution if L-BFGS-B residual is high")
    ap.add_argument("--de-maxiter", type=int, default=18)
    ap.add_argument("--de-pop", type=int, default=8)
    ap.add_argument("--maxfun-local", type=int, default=100)
    ap.add_argument(
        "--output",
        type=str,
        default=str(ROOT / "output/pareto_throat_dp_pressures.csv"),
    )
    ap.add_argument("--m-err-cap", type=float, default=0.035, help="Mission err cap for Pareto slice (L2 on F/MR frac)")
    args = ap.parse_args()

    cfg_path = Path(args.config)
    if not cfg_path.is_absolute():
        cfg_path = ROOT / cfg_path

    scenarios = _parse_tank_scenarios(args.tank_scenarios)
    n_throat = 5 if args.quick else max(3, int(args.n_throat))
    de_fb = bool(args.de_fallback) and not args.quick

    base = load_config(str(cfg_path))
    center_mm2 = _throat_center_mm2(base)
    lo_mm2 = center_mm2 * (1.0 - float(args.throat_span))
    hi_mm2 = center_mm2 * (1.0 + float(args.throat_span))
    throat_grid = np.linspace(lo_mm2, hi_mm2, num=n_throat, dtype=float)

    if base.chamber_geometry is not None:
        base.chamber_geometry.design_MR = float(args.target_MR)

    F_t = float(args.target_F)
    MR_t = float(args.target_MR)
    lo_f = float(args.p_lo_frac)
    hi_f = float(args.p_hi_frac)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    all_rows: List[Dict[str, Any]] = []

    print("=== Pareto throat × tank-cap study (pressures solved for F/MR) ===")
    print(f"Config: {cfg_path}")
    print(f"Target: F={F_t:.0f} N, MR={MR_t:.3f}")
    print(f"A_throat center={center_mm2:.2f} mm², sweep [{lo_mm2:.2f}, {hi_mm2:.2f}] mm², n={n_throat}")
    print(f"Tank scenarios [psi] (max): {scenarios}")
    print(f"Pressure search: [{lo_f:.2f},{hi_f:.2f}] × cap per stream; DE fallback={de_fb}")
    print()

    for lox_cap, fuel_cap in scenarios:
        b_o = (lox_cap * lo_f, lox_cap * hi_f)
        b_f = (fuel_cap * lo_f, fuel_cap * hi_f)
        print(f"--- Scenario LOX_cap={lox_cap:.0f}  FUEL_cap={fuel_cap:.0f} psi; bounds O [{b_o[0]:.1f},{b_o[1]:.1f}], F [{b_f[0]:.1f},{b_f[1]:.1f}] ---")

        for at_mm2 in throat_grid:
            cfg = copy.deepcopy(base)
            _apply_throat_mm2(cfg, float(at_mm2))
            runner = PintleEngineRunner(cfg)

            x_best, sq_err, _nfev = _solve_pressures(
                runner,
                F_t,
                MR_t,
                b_o,
                b_f,
                de_fallback=de_fb,
                de_maxiter=args.de_maxiter,
                de_pop=args.de_pop,
                maxfun_local=60 if args.quick else int(args.maxfun_local),
                quick_local=bool(args.quick),
            )

            if x_best is None:
                all_rows.append(
                    {
                        "lox_cap": lox_cap,
                        "fuel_cap": fuel_cap,
                        "A_throat_mm2": float(at_mm2),
                        "P_O_psi": "",
                        "P_F_psi": "",
                        "sq_err_FM": "",
                        "F_N": "",
                        "MR": "",
                        "Pc_MPa": "",
                        "dP_O_over_Pc": "",
                        "dP_F_over_Pc": "",
                        "R": "",
                        "m_err": "",
                        "ok": False,
                        "notes": "no_solver_result",
                    }
                )
                print(f"  At={at_mm2:.1f} mm²  FAIL (no solver result)")
                continue

            rowd = _row_eval(runner, float(x_best[0]), float(x_best[1]), F_t, MR_t)
            ok = rowd["ok"]
            note = ""
            if ok and rowd["r_F"] > 1.5:
                note = "high_dP_F"
            if ok and (rowd["r_O"] < 0.05 or rowd["r_F"] < 0.05):
                note = (note + "; " if note else "") + "tiny_deltaP_stream"

            rec = {
                "lox_cap": lox_cap,
                "fuel_cap": fuel_cap,
                "A_throat_mm2": float(at_mm2),
                "P_O_psi": float(x_best[0]) if ok else "",
                "P_F_psi": float(x_best[1]) if ok else "",
                "sq_err_FM": float(sq_err),
                "F_N": rowd.get("F", "") if ok else "",
                "MR": rowd.get("MR", "") if ok else "",
                "Pc_MPa": rowd.get("Pc", "") / 1e6 if ok else "",
                "dP_O_over_Pc": rowd.get("r_O", "") if ok else "",
                "dP_F_over_Pc": rowd.get("r_F", "") if ok else "",
                "R": rowd.get("R", "") if ok else "",
                "m_err": rowd.get("m_err", "") if ok else "",
                "ok": ok,
                "notes": note or rowd.get("err", ""),
            }
            all_rows.append(rec)

            if ok:
                print(
                    f"  At={at_mm2:.1f} mm²  P=({x_best[0]:.1f},{x_best[1]:.1f}) psi  "
                    f"F={rowd['F']:.0f}  MR={rowd['MR']:.3f}  m_err={rowd['m_err']:.4f}  "
                    f"dP_O={rowd['r_O']:.3f}  dP_F={rowd['r_F']:.3f}  R={rowd['R']:.3f}  sq={sq_err:.2e}"
                )
            else:
                print(f"  At={at_mm2:.1f} mm²  eval_fail: {rowd.get('err','')}")
        print()

    fieldnames = [
        "lox_cap",
        "fuel_cap",
        "A_throat_mm2",
        "P_O_psi",
        "P_F_psi",
        "sq_err_FM",
        "F_N",
        "MR",
        "Pc_MPa",
        "dP_O_over_Pc",
        "dP_F_over_Pc",
        "R",
        "m_err",
        "ok",
        "notes",
    ]
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        for r in all_rows:
            w.writerow(r)

    nd = _pareto_nd([r for r in all_rows if r.get("ok")], m_err_cap=float(args.m_err_cap))
    print("=== Non-dominated (m_err, ΔP_F/Pc), m_err ≤ {:.3f} ===".format(float(args.m_err_cap)))
    if not nd:
        print("(none — relax --m-err-cap or improve pressure bounds / physics envelope)")
    else:
        for r in nd[:20]:
            print(
                f"  caps({r['lox_cap']:.0f},{r['fuel_cap']:.0f})  At={r['A_throat_mm2']:.1f} mm²  "
                f"m_err={float(r['m_err']):.4f}  dP_F={float(r['dP_F_over_Pc']):.3f}  "
                f"P=({float(r['P_O_psi']):.1f},{float(r['P_F_psi']):.1f}) psi"
            )

    print(f"\nCSV: {out_path}")


if __name__ == "__main__":
    main()
