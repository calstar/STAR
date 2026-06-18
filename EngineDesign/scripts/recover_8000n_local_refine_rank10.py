#!/usr/bin/env python3
"""Match rank-#10 transcript metrics via bounded global search (SciPy DE).

Requires chamber_geometry.expansion_ratio == A_exit / A_throat (see nozzle.calculate_thrust).
When A_throat is varied here, A_exit is set to epsilon_fixed × A_throat with epsilon_fixed
taken once from the seed YAML after that consistency fix.
"""

from __future__ import annotations

import copy
import logging
import math
import sys
from pathlib import Path

import numpy as np
import yaml
from scipy.optimize import least_squares, minimize

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.core.runner import PintleEngineRunner
from engine.optimizer.injector_dp_penalty import injector_dp_ratios_from_eval_result
from engine.pipeline.io import load_config

PSI_TO_PA = 6894.757293168

logging.getLogger("engine.core.injectors.impinging").setLevel(logging.ERROR)

F_T = 8139.56
MR_T = 3.5085
R_T = 1.0150
DPF_T = 0.4493
N_EL = 14

C_D_O_MM = 3.314
C_D_F_MM = 2.368
C_TH_O = 30.79
C_TH_F = 54.77
C_PO = 759.07
C_PF = 747.25
C_AT = 0.00133574
C_S_O_MM = 6.2
C_S_F_MM = 4.2


def _ensure_geom_eps_aligned(cfg):
    cg = cfg.chamber_geometry
    assert cg is not None and cg.A_throat is not None and cg.A_exit is not None and float(cg.A_throat) > 0
    eps_geo = float(cg.A_exit) / float(cg.A_throat)
    cg.expansion_ratio = eps_geo
    if cfg.combustion is not None and getattr(cfg.combustion, "cea", None) is not None:
        cfg.combustion.cea.expansion_ratio = eps_geo
    return float(eps_geo)


def _apply_throat_keeps_eps(cfg, A_throat: float, eps_fixed: float):
    cg = cfg.chamber_geometry
    cg.A_throat = float(A_throat)
    cg.expansion_ratio = float(eps_fixed)
    cg.A_exit = float(A_throat) * float(eps_fixed)
    de = math.sqrt(max(0.0, 4.0 * float(cg.A_exit) / math.pi))
    cg.exit_diameter = de
    if cfg.combustion is not None and getattr(cfg.combustion, "cea", None) is not None:
        cfg.combustion.cea.expansion_ratio = float(eps_fixed)
    nz = getattr(cfg, "nozzle", None)
    if nz is not None:
        nz.A_throat = cg.A_throat
        nz.A_exit = cg.A_exit
        if hasattr(nz, "expansion_ratio"):
            setattr(nz, "expansion_ratio", float(eps_fixed))
        if hasattr(nz, "exit_diameter"):
            setattr(nz, "exit_diameter", de)


def _cost(F: float, MR: float, R: float, dpf: float) -> float:
    if not all(map(math.isfinite, (F, MR, R, dpf))):
        return 1e12
    return (
        ((F / F_T - 1.0) ** 2) * 2.0
        + ((MR / MR_T - 1.0) ** 2) * 400.0
        + ((R - R_T) ** 2) * 2500.0
        + ((dpf - DPF_T) ** 2) * 12000.0
    )


def _vec_model(x: np.ndarray, tmpl, eps_fixed: float):
    cfg = copy.deepcopy(tmpl)
    _apply_throat_keeps_eps(cfg, float(x[8]), eps_fixed)
    cfg.injector.geometry.oxidizer.n_elements = N_EL
    cfg.injector.geometry.fuel.n_elements = N_EL
    cfg.injector.geometry.oxidizer.d_jet = float(x[0]) * 1e-3
    cfg.injector.geometry.fuel.d_jet = float(x[1]) * 1e-3
    cfg.injector.geometry.oxidizer.impingement_angle = float(x[2])
    cfg.injector.geometry.fuel.impingement_angle = float(x[3])
    cfg.injector.geometry.oxidizer.spacing = float(x[4]) * 1e-3
    cfg.injector.geometry.fuel.spacing = float(x[5]) * 1e-3

    runner = PintleEngineRunner(cfg)
    res = runner.evaluate(float(x[6]) * PSI_TO_PA, float(x[7]) * PSI_TO_PA, silent=True)
    pc = float(res.get("Pc", float("nan")))
    if not math.isfinite(pc) or pc <= 0:
        raise ValueError("bad pc")

    F = float(res.get("F", float("nan")))
    MR = float(res.get("MR", float("nan")))
    diag = res.get("diagnostics") if isinstance(res.get("diagnostics"), dict) else {}
    Ru = diag.get("momentum_ratio_R")
    R = float(Ru) if Ru is not None else float("nan")
    _ro, rf = injector_dp_ratios_from_eval_result(pc, res)
    dpf = float(rf) if rf is not None and math.isfinite(float(rf)) else float("nan")
    return cfg, F, MR, R, dpf


def main() -> None:
    tmpl = load_config(ROOT / "configs" / "impinging_lox_ch4_8000N.yaml")
    eps_fixed = _ensure_geom_eps_aligned(tmpl)
    out_path = ROOT / "configs" / "impinging_lox_ch4_8000N_optimal.yaml"

    n_eval = {"n": 0}
    track: dict[str, object] = {"best": 1e30, "best_x": None, "meta": {}}

    def objective(x: np.ndarray) -> float:
        d_o_mm, d_f_mm, th_o, th_f, s_o_mm, s_f_mm, po, pf, at = x

        cfg = copy.deepcopy(tmpl)
        _apply_throat_keeps_eps(cfg, float(at), eps_fixed)

        cfg.injector.geometry.oxidizer.n_elements = N_EL
        cfg.injector.geometry.fuel.n_elements = N_EL
        cfg.injector.geometry.oxidizer.d_jet = float(d_o_mm) * 1e-3
        cfg.injector.geometry.fuel.d_jet = float(d_f_mm) * 1e-3
        cfg.injector.geometry.oxidizer.impingement_angle = float(th_o)
        cfg.injector.geometry.fuel.impingement_angle = float(th_f)
        cfg.injector.geometry.oxidizer.spacing = float(s_o_mm) * 1e-3
        cfg.injector.geometry.fuel.spacing = float(s_f_mm) * 1e-3

        try:
            runner = PintleEngineRunner(cfg)
            res = runner.evaluate(float(po) * PSI_TO_PA, float(pf) * PSI_TO_PA, silent=True)
        except Exception:
            return 1e12

        pc = float(res.get("Pc", float("nan")))
        if not math.isfinite(pc) or pc <= 0:
            return 1e12

        F = float(res.get("F", float("nan")))
        MR = float(res.get("MR", float("nan")))
        diag = res.get("diagnostics") if isinstance(res.get("diagnostics"), dict) else {}
        rv = diag.get("momentum_ratio_R")
        R = float(rv) if rv is not None else float("nan")
        _ro, rf = injector_dp_ratios_from_eval_result(pc, res)
        dpf = float(rf) if rf is not None and math.isfinite(float(rf)) else float("nan")

        n_eval["n"] += 1
        c = _cost(F, MR, R, dpf)
        if c < float(track["best"]):
            track["best"] = float(c)
            track["best_x"] = np.array(x, dtype=float, copy=True)
            track["meta"] = {"F": F, "MR": MR, "R": R, "dPf": dpf}
        if n_eval["n"] % 35 == 0:
            print(f"  eval={n_eval['n']}  best_cost={track['best']}")
        return c

    bounds = np.array(
        [
            [C_D_O_MM * 0.85, C_D_O_MM * 1.15],
            [C_D_F_MM * 0.85, C_D_F_MM * 1.15],
            [max(15.0, C_TH_O * 0.88), min(85.0, C_TH_O * 1.12)],
            [max(15.0, C_TH_F * 0.88), min(90.0, C_TH_F * 1.12)],
            [C_S_O_MM * 0.78, C_S_O_MM * 1.22],
            [C_S_F_MM * 0.78, C_S_F_MM * 1.22],
            [C_PO * 0.92, C_PO * 1.08],
            [C_PF * 0.92, C_PF * 1.08],
            [max(tmpl.chamber_geometry.A_throat * 0.52, C_AT * 0.82), tmpl.chamber_geometry.A_throat * 0.88],
        ]
    )

    x0 = np.array([C_D_O_MM, C_D_F_MM, C_TH_O, C_TH_F, C_S_O_MM, C_S_F_MM, C_PO, C_PF, C_AT])

    scipy_bounds = [(float(lo), float(hi)) for lo, hi in bounds]

    res = minimize(
        objective,
        x0,
        method="L-BFGS-B",
        bounds=scipy_bounds,
        options={
            "maxfun": 220,
            "ftol": 1e-7,
        },
    )

    bx = track.get("best_x")
    if bx is None:
        raise SystemExit("Optimizer produced no feasible evaluations.")

    xv = np.asarray(bx, dtype=float)
    best_c = float(track["best"])

    # Pass 2: vector residual polishing (prioritize thrust + MR once ΔP_F is in-band).
    def residuals(x_flat: np.ndarray) -> np.ndarray:
        try:
            _c, F, MR, R, dpf = _vec_model(np.asarray(x_flat, dtype=float), tmpl, eps_fixed)
        except Exception:
            return np.array([50.0, 50.0, 50.0, 50.0], dtype=float)

        sigma_f = 35.0
        sigma_mr = 0.04
        sigma_r = 0.012
        sigma_dp = 0.012

        rf = np.array(
            [
                (F - F_T) / sigma_f,
                (MR - MR_T) / sigma_mr,
                (R - R_T) / sigma_r,
                (dpf - DPF_T) / sigma_dp,
            ],
            dtype=float,
        )
        residuals.last_cfg = _c  # type: ignore[attr-defined]
        return rf

    lo = bounds[:, 0]
    hi = bounds[:, 1]
    xv_ls = np.clip(xv, lo, hi)
    ls_res = least_squares(
        residuals,
        xv_ls,
        bounds=(lo, hi),
        method="trf",
        max_nfev=260,
        xtol=1e-11,
        ftol=1e-11,
        gtol=1e-11,
        verbose=0,
    )
    xv_final = np.clip(np.asarray(ls_res.x, dtype=float), lo, hi)

    cfg_ls = getattr(residuals, "last_cfg", None)
    if cfg_ls is not None and hasattr(ls_res, "cost"):
        meta_ls = {}
        try:
            _c3, Fs, MRs, Rs, DPfs = _vec_model(xv_final, tmpl, eps_fixed)
            meta_ls = {"F": Fs, "MR": MRs, "R": Rs, "dPf": DPfs}
            print(f"least_squares residual cost={float(ls_res.cost):.6g}", meta_ls)
        except Exception as e:
            print("least_squares reeval failed:", e)

    xv = xv_final

    def build_cfg(vec: np.ndarray):
        cfg = copy.deepcopy(tmpl)
        _apply_throat_keeps_eps(cfg, float(vec[8]), eps_fixed)
        cfg.injector.geometry.oxidizer.n_elements = N_EL
        cfg.injector.geometry.fuel.n_elements = N_EL
        cfg.injector.geometry.oxidizer.d_jet = float(vec[0]) * 1e-3
        cfg.injector.geometry.fuel.d_jet = float(vec[1]) * 1e-3
        cfg.injector.geometry.oxidizer.impingement_angle = float(vec[2])
        cfg.injector.geometry.fuel.impingement_angle = float(vec[3])
        cfg.injector.geometry.oxidizer.spacing = float(vec[4]) * 1e-3
        cfg.injector.geometry.fuel.spacing = float(vec[5]) * 1e-3
        return cfg

    cfg_out = build_cfg(xv)
    rr = PintleEngineRunner(cfg_out).evaluate(float(xv[6]) * PSI_TO_PA, float(xv[7]) * PSI_TO_PA, silent=True)
    pc_f = float(rr.get("Pc", float("nan")))
    _ro, rf = injector_dp_ratios_from_eval_result(pc_f, rr)
    diag_o = rr.get("diagnostics") if isinstance(rr.get("diagnostics"), dict) else {}
    Ru = diag_o.get("momentum_ratio_R")

    print("L-BFGS-B success=", res.success, "message=", res.message)
    print("best cost during search=", float(best_c))
    print(
        f"reeval best: F={rr.get('F')}  MR={rr.get('MR')}  R={Ru}  "
        f"dP_O={_ro}  dP_F={rf}  n={N_EL}"
    )
    print("x (d_o_mm, d_f_mm, th_o, th_f, s_o_mm, s_f_mm, Po, Pf, A_throat):\n ", xv)

    out_path.write_text(yaml.safe_dump(cfg_out.model_dump(mode="json"), sort_keys=False))
    print(f"wrote {out_path.resolve()}")


if __name__ == "__main__":
    main()
