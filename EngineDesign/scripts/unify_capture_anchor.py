"""Capture a golden anchor fixture for the unification effort (UNIFICATION_PLAN.md Phase 1).

Runs deterministic forward evaluations against a target EngineDesign tree (main worktree or HEAD)
and dumps the physics outputs as JSON. Stability fields are recorded for reference but are NOT part
of the equivalence set (the stability model intentionally changed on this branch).

Usage:
    python scripts/unify_capture_anchor.py <target_engine_design_root> <config_yaml> <out_json>

IMPORTANT: run with cwd = <target_engine_design_root> so the target tree's `engine` package is the
one imported (sys.path[0] insertion below enforces it as well).
"""

import json
import sys
from pathlib import Path

import numpy as np


def _to_jsonable(v):
    if isinstance(v, (np.floating, np.integer)):
        return float(v)
    if isinstance(v, (int, float, str, bool)) or v is None:
        return v
    return None  # drop arrays/objects — anchors compare scalars only


# Physics fields that define anchor equivalence (stability excluded by design).
ANCHOR_FIELDS = [
    "Pc", "F", "Isp", "MR", "mdot_O", "mdot_F", "mdot_total",
    "P_exit", "Tc", "Cf", "v_exit", "M_exit", "eps",
]
DIAG_FIELDS = [
    "Cd_O", "Cd_F", "delta_p_injector_O", "delta_p_injector_F",
    "delta_p_feed_O", "delta_p_feed_F", "D32_O", "D32_F",
    "We_O", "We_F", "momentum_ratio_R", "TMR", "J",
]


def main():
    target = Path(sys.argv[1]).resolve()
    cfg_path = Path(sys.argv[2]).resolve()
    out_path = Path(sys.argv[3]).resolve()

    sys.path.insert(0, str(target))
    from engine.pipeline.io import load_config            # noqa: E402  (target tree)
    from engine.core.runner import PintleEngineRunner     # noqa: E402

    config = load_config(str(cfg_path))
    runner = PintleEngineRunner(config)

    psi = 6894.757
    p_lox0 = float(getattr(config.lox_tank, "initial_pressure_psi", 700.0))
    p_fuel0 = float(getattr(config.fuel_tank, "initial_pressure_psi", 600.0))

    points = []
    for scale in (1.0, 0.9, 1.1):
        P_O, P_F = p_lox0 * scale * psi, p_fuel0 * scale * psi
        res = runner.evaluate(P_tank_O=P_O, P_tank_F=P_F)
        diag = res.get("diagnostics", {}) or {}
        points.append({
            "P_tank_O_psi": p_lox0 * scale,
            "P_tank_F_psi": p_fuel0 * scale,
            "outputs": {k: _to_jsonable(res.get(k)) for k in ANCHOR_FIELDS},
            "diagnostics": {k: _to_jsonable(diag.get(k)) for k in DIAG_FIELDS},
            # reference-only (non-comparable): stability summary of whatever model the tree has
            "stability_ref": {
                "state": (res.get("stability_results") or {}).get("stability_state"),
                "score": _to_jsonable((res.get("stability_results") or {}).get("stability_score")),
            },
        })

    fixture = {
        "meta": {
            "target_tree": str(target),
            "config": str(cfg_path),
            "fuel": str(config.fluids["fuel"].name),
            "oxidizer": str(config.fluids["oxidizer"].name),
            "injector_type": str(config.injector.type),
            "equivalence_fields": {"outputs": ANCHOR_FIELDS, "diagnostics": DIAG_FIELDS},
            "note": "stability_ref is informational only — NOT part of anchor equivalence",
        },
        "points": points,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(fixture, indent=2))
    print(f"wrote {out_path}")
    for p in points:
        o = p["outputs"]
        print(f"  scale point: Pc={o['Pc']:.0f} Pa  F={o['F']:.1f} N  MR={o['MR']:.4f}  Isp={o['Isp']:.2f}")


if __name__ == "__main__":
    main()
