#!/usr/bin/env python3
"""Build controller policy LUT by running DDP offline over a grid.

Usage:
    cd engine_sim && python scripts/build_policy_lut.py [options]

Options:
    --controller-config PATH   Controller YAML (default: configs/robust_ddp_default.yaml)
    --engine-config PATH      Engine YAML (default: configs/default.yaml)
    --output PATH             Output .npz file (default: configs/policy_lut.npz)
    --grid P_F P_O F MR       Grid resolution: n_P_u_F n_P_u_O n_F_ref n_MR_ref (default: 6 6 8 5)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

# Add engine_sim root to path
_ENGINE_SIM_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ENGINE_SIM_ROOT))

from engine.control.robust_ddp.config_loader import load_config as load_controller_config
from engine.control.robust_ddp.dynamics import (
    DynamicsParams,
    N_STATE,
    N_CONTROL,
    IDX_P_COPV,
    IDX_P_REG,
    IDX_P_U_F,
    IDX_P_U_O,
    IDX_P_D_F,
    IDX_P_D_O,
    IDX_V_U_F,
    IDX_V_U_O,
    IDX_M_GAS_COPV,
    IDX_M_GAS_F,
    IDX_M_GAS_O,
)
from engine.control.robust_ddp.ddp_solver import solve_ddp
from engine.control.robust_ddp.robustness import get_w_bar_array
from engine.control.robust_ddp.data_models import ControllerState
from engine.control.robust_ddp.policy_lut import PolicyLUT
from engine.pipeline.io import load_config as load_engine_config


# Grid bounds (operating envelope)
P_U_F_MIN = 2.0e6   # 2 MPa
P_U_F_MAX = 10.0e6  # 10 MPa
P_U_O_MIN = 2.0e6
P_U_O_MAX = 10.0e6
F_REF_MIN = 0.0
F_REF_MAX = 5000.0  # 5 kN
MR_REF_MIN = 1.5
MR_REF_MAX = 3.0


def build_state_from_pressures(
    P_u_F: float,
    P_u_O: float,
    cfg,
    dynamics_params,
) -> np.ndarray:
    """Build full state vector from ullage pressures."""
    R_gas = 296.8
    T_gas = 293.0
    Z_gas = 1.0
    V_copv = getattr(dynamics_params, "V_copv", 0.006)
    V_u_F = 0.01
    V_u_O = 0.01

    P_copv = getattr(cfg, "reg_setpoint", 6.89476e6) * 1.5 if cfg.reg_setpoint else 15e6
    P_reg = cfg.reg_setpoint if cfg.reg_setpoint else P_copv * cfg.reg_ratio
    P_d_F = P_u_F * 0.95
    P_d_O = P_u_O * 0.95

    m_gas_copv = (P_copv * V_copv * Z_gas) / (R_gas * T_gas)
    m_gas_F = (P_u_F * V_u_F * Z_gas) / (R_gas * T_gas) if V_u_F > 1e-10 else 0.0
    m_gas_O = (P_u_O * V_u_O * Z_gas) / (R_gas * T_gas) if V_u_O > 1e-10 else 0.0

    return np.array([
        P_copv, P_reg, P_u_F, P_u_O, P_d_F, P_d_O,
        V_u_F, V_u_O,
        m_gas_copv, m_gas_F, m_gas_O,
    ], dtype=np.float64)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build DDP controller policy LUT")
    parser.add_argument(
        "--controller-config",
        type=str,
        default=str(_ENGINE_SIM_ROOT / "configs" / "robust_ddp_default.yaml"),
        help="Controller config YAML",
    )
    parser.add_argument(
        "--engine-config",
        type=str,
        default=str(_ENGINE_SIM_ROOT / "configs" / "default.yaml"),
        help="Engine config YAML",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=str(_ENGINE_SIM_ROOT / "configs" / "policy_lut.npz"),
        help="Output LUT .npz path",
    )
    parser.add_argument(
        "--grid",
        type=int,
        nargs=4,
        default=[6, 6, 8, 5],
        metavar=("P_F", "P_O", "F", "MR"),
        help="Grid resolution (n_P_u_F n_P_u_O n_F_ref n_MR_ref)",
    )
    parser.add_argument(
        "--max-iterations",
        type=int,
        default=None,
        help="Override DDP max iterations (default: use config)",
    )
    args = parser.parse_args()

    print("Loading configs...")
    cfg = load_controller_config(args.controller_config)
    if args.max_iterations is not None:
        cfg.max_iterations = args.max_iterations
        print(f"  Overriding max_iterations={args.max_iterations}")
    engine_config = load_engine_config(args.engine_config)

    from engine.control.robust_ddp.engine_wrapper import EngineWrapper
    engine_wrapper = EngineWrapper(engine_config)
    dynamics_params = DynamicsParams.from_config(cfg)

    n_P_F, n_P_O, n_F, n_MR = args.grid
    axes = [
        np.linspace(P_U_F_MIN, P_U_F_MAX, n_P_F),
        np.linspace(P_U_O_MIN, P_U_O_MAX, n_P_O),
        np.linspace(F_REF_MIN, F_REF_MAX, n_F),
        np.linspace(MR_REF_MIN, MR_REF_MAX, n_MR),
    ]

    u_grid = np.zeros((n_P_F, n_P_O, n_F, n_MR, N_CONTROL), dtype=np.float64)
    state = ControllerState()
    w_bar = get_w_bar_array(state)

    total = n_P_F * n_P_O * n_F * n_MR
    done = 0

    print(f"Building LUT: grid {n_P_F}x{n_P_O}x{n_F}x{n_MR} = {total} points")
    print("Axes: P_u_F [MPa], P_u_O [MPa], F_ref [kN], MR_ref")

    for i, P_u_F in enumerate(axes[0]):
        for j, P_u_O in enumerate(axes[1]):
            for k, F_ref in enumerate(axes[2]):
                for m, MR_ref in enumerate(axes[3]):
                    x0 = build_state_from_pressures(
                        P_u_F, P_u_O, cfg, dynamics_params
                    )
                    F_ref_seq = np.full(cfg.N, F_ref, dtype=np.float64)
                    MR_ref_seq = np.full(cfg.N, MR_ref, dtype=np.float64)
                    u_init = np.full((cfg.N, N_CONTROL), 0.2, dtype=np.float64)

                    try:
                        solution = solve_ddp(
                            x0=x0,
                            u_seq_init=u_init,
                            F_ref=F_ref_seq,
                            MR_ref=MR_ref_seq,
                            cfg=cfg,
                            dynamics_params=dynamics_params,
                            engine_wrapper=engine_wrapper,
                            w_bar=w_bar,
                            use_robustification=True,
                        )
                        u_grid[i, j, k, m, :] = solution.u_seq[0]
                    except Exception as e:
                        u_grid[i, j, k, m, :] = 0.1  # Fallback
                        if done < 5:
                            print(f"  Warning at ({i},{j},{k},{m}): {e}")

                    done += 1
                    if done % 100 == 0 or done == total:
                        print(f"  Progress: {done}/{total} ({100*done/total:.1f}%)")

    lut = PolicyLUT(axes=axes, u_grid=u_grid, bounds_mode="clip")
    lut.save(args.output)
    print(f"Saved LUT to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
