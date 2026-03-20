#!/usr/bin/env python3
"""
Extract thrust curve from engine config pressure_curves.
Evaluates engine at each (P_fuel, P_lox) point and reports thrust + pressure range.
Used to set policy LUT axes to cover the config's thrust curve.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np


# Add engine_sim to path
def _add_engine_sim(project_root: Path) -> None:
    engine_sim_root = project_root / "engine_sim"
    if str(engine_sim_root) not in sys.path:
        sys.path.insert(0, str(engine_sim_root))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract thrust curve from engine config"
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("engine_sim/configs/default.yaml"),
        help="Engine config path (relative to project root)",
    )
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument(
        "--json", action="store_true", help="Output JSON for downstream use"
    )
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        default=None,
        help="Write thrust curve (time_s, thrust_N) to CSV for FSW",
    )
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    config_path = project_root / args.config
    if not config_path.exists():
        print(f"Config not found: {config_path}", file=sys.stderr)
        sys.exit(1)

    _add_engine_sim(project_root)

    from engine.pipeline.io import load_config as load_engine_config
    from engine.core.runner import PintleEngineRunner
    from engine.optimizer.layers.layer2_pressure import (
        generate_pressure_curve_from_segments,
    )

    cfg = load_engine_config(str(config_path))
    pc = cfg.pressure_curves
    if pc is None:
        print("No pressure_curves in config", file=sys.stderr)
        sys.exit(1)

    n_points = pc.n_points
    lox_segments = [
        {
            "length_ratio": s.length_ratio,
            "type": s.type,
            "start_pressure": s.start_pressure_pa,
            "end_pressure": s.end_pressure_pa,
            "k": s.k or 0.3,
        }
        for s in pc.lox_segments
    ]
    fuel_segments = [
        {
            "length_ratio": s.length_ratio,
            "type": s.type,
            "start_pressure": s.start_pressure_pa,
            "end_pressure": s.end_pressure_pa,
            "k": s.k or 0.3,
        }
        for s in pc.fuel_segments
    ]

    P_lox = generate_pressure_curve_from_segments(lox_segments, n_points)
    P_fuel = generate_pressure_curve_from_segments(fuel_segments, n_points)

    runner = PintleEngineRunner(cfg)
    thrust = np.zeros(n_points)
    for i in range(n_points):
        try:
            res = runner.evaluate(
                P_tank_O=float(P_lox[i]), P_tank_F=float(P_fuel[i]), silent=True
            )
            thrust[i] = float(res.get("F", np.nan))
        except Exception:
            thrust[i] = np.nan

    valid = np.isfinite(thrust)
    F_min = float(np.min(thrust[valid])) if np.any(valid) else 0.0
    F_max = float(np.max(thrust[valid])) if np.any(valid) else 0.0
    P_fuel_min = float(np.min(P_fuel))
    P_fuel_max = float(np.max(P_fuel))
    P_lox_min = float(np.min(P_lox))
    P_lox_max = float(np.max(P_lox))

    if args.output is not None:
        burn_time_s = pc.target_burn_time_s
        time_s = np.linspace(0.0, burn_time_s, n_points)
        out_path = args.output
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w") as f:
            f.write("time_s,thrust_N\n")
            for t, F in zip(time_s, thrust):
                if np.isfinite(F):
                    f.write(f"{t:.6f},{F:.2f}\n")
        print(f"Wrote thrust curve to {out_path} ({n_points} points, {burn_time_s:.2f} s)")

    if args.json:
        import json

        out = {
            "thrust_min_N": F_min,
            "thrust_max_N": F_max,
            "P_u_fuel_min_Pa": P_fuel_min,
            "P_u_fuel_max_Pa": P_fuel_max,
            "P_u_ox_min_Pa": P_lox_min,
            "P_u_ox_max_Pa": P_lox_max,
            "n_points": n_points,
            "burn_time_s": pc.target_burn_time_s,
        }
        print(json.dumps(out, indent=2))
    elif args.output is None:
        print(f"Thrust: {F_min:.0f} – {F_max:.0f} N")
        print(f"P_u_fuel: {P_fuel_min/1e6:.2f} – {P_fuel_max/1e6:.2f} MPa")
        print(f"P_u_ox:   {P_lox_min/1e6:.2f} – {P_lox_max/1e6:.2f} MPa")
        print(f"Points: {n_points}, burn_time: {pc.target_burn_time_s} s")


if __name__ == "__main__":
    main()
