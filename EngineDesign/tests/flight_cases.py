"""Shared inputs for the flight tests: the shipped 6.5 kN vehicle and its thrust curve.

The curve is the one the config header states for the flat dome-regulated burn through the
time-varying solver: thrust 6500.0 -> 6601.9 N and mdot 2.7976 -> 2.8550 kg/s, linear over
3.8978 s, split at the delivered O/F 1.5013. Using the header numbers keeps these tests off the
engine solver, which is not what they check.
"""

from __future__ import annotations

import contextlib
import copy
import io
import math
from pathlib import Path

import numpy as np

CONFIG = Path(__file__).resolve().parents[1] / "configs" / "ethalox_6500N.yaml"
BURN_S = 3.8978
OF = 1.5013


def header_curve(n: int = 200):
    t = np.linspace(0.0, BURN_S, n)
    F = 6500.0 + (6601.9 - 6500.0) * t / BURN_S
    md = 2.7976 + (2.8550 - 2.7976) * t / BURN_S
    return t, F, md * OF / (1 + OF), md / (1 + OF)


def shipped():
    from engine.pipeline.io import load_config

    return load_config(str(CONFIG))


def curve_integrals():
    t, F, mO, mF = header_curve()
    return float(np.trapezoid(F, t)), float(np.trapezoid(mO, t)), float(np.trapezoid(mF, t))


def roomy_tanks(cfg, load_factor: float = 1.001, fill: float = 0.8):
    """Tanks sized so the curve's own propellant fills them to `fill`: no cap can bite."""
    _, IO, IF = curve_integrals()
    cfg.design_requirements.lox_tank_capacity_kg = None
    cfg.design_requirements.fuel_tank_capacity_kg = None
    for sec, h, r, m, rho in (
        (cfg.lox_tank, "lox_h", "lox_radius", IO, cfg.fluids["oxidizer"].density),
        (cfg.fuel_tank, "rp1_h", "rp1_radius", IF, cfg.fluids["fuel"].density),
    ):
        V = m * load_factor / rho / fill
        sec.tank_volume_m3 = V
        setattr(sec, h, V / (math.pi * getattr(sec, r) ** 2))
    return cfg


def fly(cfg, curve=None):
    """ui.flight_sim.setup_flight on the curve, quietly."""
    from scipy.interpolate import interp1d
    from ui.flight_sim import setup_flight

    t, F, mO, mF = curve or header_curve()
    cfg = copy.deepcopy(cfg)
    cfg.thrust.burn_time = float(t[-1])
    f = lambda y: interp1d(t, y, bounds_error=False, fill_value=0.0)  # noqa: E731
    with contextlib.redirect_stdout(io.StringIO()):
        return setup_flight(cfg, f(F), f(mO), f(mF))


def fly_helpers(cfg, curve=None):
    """The Flight tab's path: engine.optimizer.copv_flight_helpers.run_flight_simulation."""
    from engine.optimizer.copv_flight_helpers import run_flight_simulation

    t, F, mO, mF = curve or header_curve()
    with contextlib.redirect_stdout(io.StringIO()):
        return run_flight_simulation(copy.deepcopy(cfg), {"time": t, "thrust": F, "mdot_O": mO, "mdot_F": mF}, float(t[-1]))
