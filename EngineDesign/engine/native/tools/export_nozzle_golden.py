"""Export frozen-nozzle golden vectors for test_nozzle_golden.c (Phase 1a).

For each canonical engine + tank-pressure point we solve the chamber (Python,
shifting OFF) to land on a converged operating point, read the exact CEA thermo
the nozzle consumes — cea_cache.eval(MR, Pc, Pa, eps) — as the nozzle INPUTS, and
record the FROZEN nozzle OUTPUTS from runner.evaluate(). The C kernel is fed those
same inputs and must reproduce the outputs (isolates nozzle arithmetic; CEA parity
is covered separately by test_cea_interp).

Output: tests/golden/nozzle_golden.json — a flat JSON array (the C harness parser
only handles non-nested objects, so every key lives at the top level of a sample).

Run:  .venv/bin/python -m engine.native.tools.export_nozzle_golden
"""

from __future__ import annotations

import os

os.environ["ED_USE_NATIVE"] = "0"  # Python oracle.

import json
from pathlib import Path

from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner

PSI_TO_PA = 6894.76
PA = 101325.0
REPO = Path(__file__).resolve().parents[3]
OUT = REPO / "engine" / "native" / "tests" / "golden" / "nozzle_golden.json"

CASES = [
    ("pintle", "configs/canonical/pintle.yaml", 523.6759162449396, 537.261547029532),
    ("impinging", "configs/canonical/impinging.yaml", 563.4671262691785, 567.6435444099167),
]
PERTURB = [(1.00, 1.00), (0.92, 0.97), (1.06, 1.03)]


def _set_shifting(config, enabled: bool) -> None:
    eff = getattr(getattr(config, "combustion", None), "efficiency", None)
    if eff is not None and hasattr(eff, "use_shifting_equilibrium"):
        eff.use_shifting_equilibrium = enabled


def main() -> None:
    samples = []
    for label, rel_path, p_o_psi, p_f_psi in CASES:
        config = load_config(REPO / rel_path)
        runner = PintleEngineRunner(config)
        _set_shifting(runner.config, False)  # FROZEN reference.
        cg = runner.config.chamber_geometry
        eps = float(cg.expansion_ratio)
        for mo, mf in PERTURB:
            p_o = p_o_psi * mo * PSI_TO_PA
            p_f = p_f_psi * mf * PSI_TO_PA
            res = runner.evaluate(p_o, p_f, P_ambient=PA, silent=True)
            diag = res["diagnostics"]
            Pc = float(res["Pc"])
            MR = float(res["MR"])
            mdot_total = float(diag["mdot_O"]) + float(diag["mdot_F"])
            # Exact thermo the nozzle read internally (nozzle.py:229).
            cea = runner.cea_cache.eval(MR, Pc, PA, eps)
            samples.append({
                "case": label,
                # --- inputs ---
                "Pc": Pc,
                "mdot_total": mdot_total,
                "A_throat": float(cg.A_throat),
                "A_exit": float(cg.A_exit),
                "eps": eps,
                "Pa": PA,
                "nozzle_efficiency": float(cg.nozzle_efficiency),
                "Cf_ideal": float(cea["Cf_ideal"]),
                "gamma": float(cea["gamma"]),
                "R": float(cea["R"]),
                "Tc": float(cea["Tc"]),
                # --- expected frozen outputs ---
                "F": float(res["F"]),
                "Cf_actual": float(res["Cf_actual"]),
                "P_exit": float(res["P_exit"]),
                "T_exit": float(res["T_exit"]),
                "v_exit": float(res["v_exit"]),
                "M_exit": float(res["M_exit"]),
                "P_throat": float(res["P_throat"]),
                "T_throat": float(res["T_throat"]),
                "Isp": float(res["Isp"]),
            })
            print(f"{label:>10}  Pc={Pc/1e5:6.2f} bar  F={res['F']:8.1f} N  "
                  f"Isp={res['Isp']:6.2f} s  M_exit={res['M_exit']:.4f}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(samples, indent=1))
    print(f"\nwrote {len(samples)} samples -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
