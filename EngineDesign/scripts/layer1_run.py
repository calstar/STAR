"""Run Layer 1 on a config and write both the summary and the optimised config.

    python3 scripts/layer1_run.py --config configs/ethalox_8kN_SHIP.yaml --out /tmp/run.json

Writes <out> (summary JSON) and <out with _config.yaml> (the design itself -- that file is
the artifact, the summary is not). Pin layer1_random_seed in the config for a reproducible
result; Layer 1 has two recurring basins and an unseeded run can land in either.
"""
import sys, copy, json, argparse
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config', required=True)
    ap.add_argument('--out', default='', help='summary JSON path; default alongside the config')
    ap.add_argument('--label', default='')
    a = ap.parse_args()
    if not a.out:
        a.out = str(Path(a.config).with_suffix('.layer1.json'))
    cfg = load_config(a.config)
    req = cfg.design_requirements.model_dump()
    runner = PintleEngineRunner(copy.deepcopy(cfg))
    pcfg = {"mode": "optimizer_controlled",
            "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
            "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"])}
    opt_cfg, results = run_layer1_optimization(
        config_obj=copy.deepcopy(cfg), runner=runner, requirements=req,
        target_burn_time=float(req.get("target_burn_time", 6.0)),
        tolerances={"thrust": 0.10, "apogee": 0.15}, pressure_config=pcfg)
    perf = results.get("performance") or {}
    ci = results.get("convergence_info") or {}
    out = {
      "label": a.label, "config": a.config,
      "failure_reasons": list(perf.get("failure_reasons") or []),
      "gates": {k: v for k, v in perf.items() if k.endswith("_check_passed") or k.endswith("_gate_passed")},
      "MR": perf.get("MR"), "F": perf.get("F"), "Pc_psi": (perf.get("Pc") or 0)/6894.757,
      "Isp": perf.get("Isp"), "Lstar": perf.get("layer1_geometry_Lstar_config_m"),
      "CR": perf.get("layer1_geometry_Ac_over_At"), "eta_cstar": perf.get("eta_cstar"),
      "R": perf.get("momentum_ratio_R"), "n_F": perf.get("momentum_ratio_n_elements_F"),
      "n_O": perf.get("momentum_ratio_n_elements_O"),
      "imp_angle": perf.get("impingement_angle_deg_effective"),
      "smd_um": perf.get("effective_smd_microns"),
      "D_over_Dt": (ci.get("best_objective_breakdown") or {}).get("chamber_D_over_Dt"),
      "best_objective": ci.get("best_objective"),
      "breakdown": ci.get("best_objective_breakdown"),
    }
    # emit the optimised config too -- this is the artifact, not the summary.
    # No try/except: if this cannot be written I want to know why, loudly.
    import yaml as _yaml
    from backend.routers.config import config_to_dict
    _yaml.safe_dump(config_to_dict(opt_cfg),
                    open(a.out.replace('.json', '_config.yaml'), 'w'),
                    sort_keys=False, default_flow_style=False)
    json.dump(out, open(a.out, 'w'), indent=1, default=str)
    print("RESULT " + json.dumps({k: v for k, v in out.items() if k != "breakdown"}, default=str))

if __name__ == '__main__':
    main()
