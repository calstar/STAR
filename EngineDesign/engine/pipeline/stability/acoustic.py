"""High-frequency (acoustic / "screech") stability: per-mode growth rate.

Implements the modal growth-rate balance [Phys §4.2, eq 4.1] as a **lumped, normalized** design-guidance
model (we do not have spatial mode shapes / heat-release fields in Layer 1, so the mode-shape/heat-
release overlap is a documented per-mode factor, not an integral):

    alpha_mode = alpha_drive - alpha_damp

    alpha_drive = (omega/2) * (gamma-1) * overlap * Re[ n*(1 - e^{-i*omega*tau_sens}) ]
                = (omega/2) * (gamma-1) * overlap * n * (1 - cos(omega * tau_sens))  [Phys §2, §4.2]

    alpha_damp  = alpha_nozzle + alpha_viscous + alpha_injector + alpha_twophase     (itemized budget)

A mode **grows** when alpha_mode > 0. The driving is the part of the n-tau response IN PHASE with p'
(Rayleigh): n(1 - cos omega*tau) >= 0, largest at omega*tau = pi and zero at 2*pi -- Crocco's
stability bucket (Harrje & Reardon SP-194 ch. 4). The quadrature part n*sin(omega*tau) shifts the
frequency and does no work; this module used to take it, which booked combustion as DAMPING over
half of every period of omega*tau.

Two margins per mode, both 1 at neutral stability:
  * ``margin``             = damping / driving at the model's tau_sens (nominal phase);
  * ``margin_worst_phase`` = damping / driving at omega*tau = pi = n_min / n, Crocco's interaction-
    index margin, independent of tau.

Why the verdict is report-only by default (analysis.py): omega*tau_sens is tens of radians (1T ~ 29
rad on the 6500 N) and tau_sens = chi*tau_vap with chi uncalibrated, so the nominal-phase margin
flips with a few percent of tau; the worst-phase margin is set by gamma, n, the overlap and the
injector/two-phase fractions, none of which the design moves. Harrje & Reardon rate HF stability by
test (bomb / pulse, >= 25 kHz Pc), and so does this tool until T7/H3 calibrate the damping.

Pure numeric module — params in as scalars/dataclasses; integration (config -> params) lives in analysis.py.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional
import numpy as np

from engine.pipeline.stability import core


# Default mode-shape / heat-release overlap per mode [-], in [0,1]. The flame sits near the injector
# face; longitudinal modes have a pressure antinode there (high overlap), transverse modes are
# distributed across the face (moderate). ASSUMED, uncalibrated -- no source; override when better
# data exists.
DEFAULT_OVERLAP: Dict[str, float] = {
    "1L": 0.70, "2L": 0.45, "3L": 0.30,
    "1T": 0.40, "2T": 0.30, "1R": 0.35, "3T": 0.25, "1T1R": 0.25,
}


@dataclass
class GasState:
    """Chamber gas + nozzle conditions needed for the damping budget."""
    gamma: float
    a_sound: float          # m/s
    nu_g: float             # m^2/s, gas kinematic viscosity (mu/rho) in the chamber
    mach_nozzle_entrance: float = 0.2   # mean Mach at nozzle entrance (sets nozzle damping)
    prandtl: Optional[float] = None     # hot-gas Pr for the Kirchhoff thermal layer; None = viscous only


@dataclass
class DampingCoeffs:
    """Injector-face and two-phase damping, as fractions of pi*f. ASSUMED, uncalibrated: no closed
    form exists; calibrate against a cold ring-down (T7) and hot-fire pulse test (H3)."""
    injector_frac: float = 0.02      # alpha_inj ~ injector_frac * pi * f
    twophase_frac: float = 0.03      # alpha_2phi ~ twophase_frac * pi * f * droplet_loading
    droplet_loading: float = 1.0     # O(1) relative liquid loading near the front end


def _is_longitudinal(mode_name: Optional[str]) -> bool:
    """Pure axial mode ("1L", "2L", ...). Anything else is transverse or mixed."""
    return mode_name is None or (mode_name.endswith("L") and mode_name[:-1].isdigit())


# ---------------------------------------------------------------------------
# Damping budget
# ---------------------------------------------------------------------------

def damping_budget(f_hz: float, D_ch: float, L_ch: float, gas: GasState,
                   coeffs: Optional[DampingCoeffs] = None,
                   mode_name: Optional[str] = None) -> Dict[str, float]:
    """Itemized acoustic damping rates [1/s] for a mode at frequency ``f_hz``.  [Phys §4.2 — viz #2]

    Keys: ``nozzle``, ``viscous``, ``injector``, ``twophase``, ``total``. All >= 0 (damping).
    ``mode_name`` sets the nozzle-plane weight (longitudinal 1, transverse 1/2; None = longitudinal).
    """
    coeffs = coeffs or DampingCoeffs()
    w_end = 1.0 if _is_longitudinal(mode_name) else 0.5
    a_noz = core.nozzle_damping_rate(gas.a_sound, L_ch, gas.mach_nozzle_entrance, gas.gamma,
                                     end_weight=w_end)
    a_vis = core.viscous_damping_rate(f_hz, D_ch, gas.nu_g, gas.gamma, gas.prandtl)
    a_inj = coeffs.injector_frac * np.pi * f_hz
    a_2ph = coeffs.twophase_frac * np.pi * f_hz * coeffs.droplet_loading
    total = a_noz + a_vis + a_inj + a_2ph
    return {"nozzle": float(a_noz), "viscous": float(a_vis), "injector": float(a_inj),
            "twophase": float(a_2ph), "total": float(total)}


# ---------------------------------------------------------------------------
# Per-mode growth rate
# ---------------------------------------------------------------------------

def mode_driving_rate(f_hz: float, gamma: float, overlap: float, n: float, tau_sens: float) -> float:
    """Combustion driving rate [1/s]: (omega/2)(gamma-1)*overlap*n*(1 - cos(omega*tau_sens)).

    Rayleigh: the part of the n-tau response in phase with p', ``Re[core.n_tau_gain]``. >= 0.
    """
    omega = 2.0 * np.pi * f_hz
    drive_phase = core.n_tau_gain(omega, n, tau_sens).real   # = n*(1 - cos(omega*tau_sens))
    return float(0.5 * omega * (gamma - 1.0) * overlap * drive_phase)


def mode_driving_rate_max(f_hz: float, gamma: float, overlap: float, n: float) -> float:
    """Largest driving any lag can give [1/s]: omega*tau = pi, ``omega*(gamma-1)*overlap*n``."""
    return float(2.0 * np.pi * f_hz * (gamma - 1.0) * overlap * n)


def _ratio(num: float, den: float) -> float:
    """damping/driving; no driving -> infinite margin."""
    return float(num / den) if den > 0.0 else float("inf")


def mode_growth_rate(f_hz: float, mode_name: str, D_ch: float, L_ch: float, gas: GasState,
                     *, n: float, tau_sens: float,
                     overlap: Optional[float] = None,
                     coeffs: Optional[DampingCoeffs] = None) -> Dict[str, float]:
    """Net growth rate for one acoustic mode, with its damping budget and margins.

    ``alpha = driving - damping_total``; **stable if alpha < 0**.  [Phys §4.2, eq 4.1]
    ``margin`` = damping/driving at tau_sens; ``margin_worst_phase`` = damping/driving at
    omega*tau = pi (= n_min/n). Both > 1 is stable; ``n_min`` is the interaction index at which the
    mode goes neutral at the worst phase.
    """
    ov = overlap if overlap is not None else DEFAULT_OVERLAP.get(mode_name, 0.3)
    drive = mode_driving_rate(f_hz, gas.gamma, ov, n, tau_sens)
    drive_max = mode_driving_rate_max(f_hz, gas.gamma, ov, n)
    damp = damping_budget(f_hz, D_ch, L_ch, gas, coeffs, mode_name=mode_name)
    alpha = drive - damp["total"]
    m_worst = _ratio(damp["total"], drive_max)
    return {
        "mode": mode_name, "f_hz": float(f_hz), "overlap": float(ov),
        "driving": float(drive), "driving_max": float(drive_max),
        "damping": damp, "damping_total": damp["total"],
        "alpha": float(alpha), "stable": bool(alpha < 0.0),
        "margin": _ratio(damp["total"], drive),
        "margin_worst_phase": m_worst,
        "n_min": float(n * m_worst) if np.isfinite(m_worst) else float("inf"),
    }


# ---------------------------------------------------------------------------
# Full analysis (rich) and fast subset
# ---------------------------------------------------------------------------

def _mode_frequencies(gas: GasState, L_ch: float, D_ch: float, n_long: int) -> Dict[str, float]:
    freqs: Dict[str, float] = {}
    for i, f in enumerate(core.longitudinal_mode_frequencies(gas.a_sound, L_ch, n_long), start=1):
        freqs[f"{i}L"] = f
    freqs.update(core.transverse_mode_frequencies(gas.a_sound, D_ch))
    return freqs


def analyze_acoustic_modes(D_ch: float, L_ch: float, gas: GasState,
                           *, n: float, tau_sens: float,
                           coeffs: Optional[DampingCoeffs] = None,
                           n_long: int = 3) -> Dict[str, object]:
    """Rich acoustic analysis: growth rate + damping budget for every mode (1L..3L, 1T, 2T, 1R, 3T...).

    Returns ``{"modes": [per-mode dicts sorted by alpha desc], "limiting_mode": name, "any_unstable": bool}``.
    [Phys §4.2 — feeds viz #2 (damping bars), #3 (frequency ladder), #4 (phase clock)]
    """
    freqs = _mode_frequencies(gas, L_ch, D_ch, n_long)
    modes: List[Dict[str, float]] = []
    for name, f in freqs.items():
        if f <= 0:
            continue
        modes.append(mode_growth_rate(f, name, D_ch, L_ch, gas, n=n, tau_sens=tau_sens, coeffs=coeffs))
    modes.sort(key=lambda m: m["alpha"], reverse=True)
    limiting = modes[0]["mode"] if modes else None
    return {
        "modes": modes,
        "limiting_mode": limiting,
        "any_unstable": bool(any(m["alpha"] > 0.0 for m in modes)),
    }


def fast_acoustic(D_ch: float, L_ch: float, gas: GasState,
                  *, n: float, tau_sens: float,
                  coeffs: Optional[DampingCoeffs] = None) -> Dict[str, float]:
    """Fast acoustic check for the Layer-1 loop: only 1L and 1T (the usual first offenders).

    Returns ``alpha_max``, ``limiting_mode``, ``stable``, ``f_1L``, ``f_1T``, and the smallest
    ``margin`` (nominal phase) and ``margin_worst_phase`` over the two modes, each with the mode
    that sets it.
    """
    a = gas.a_sound
    f_1L = core.longitudinal_mode_frequencies(a, L_ch, 1)
    f_1L = f_1L[0] if f_1L else 0.0
    f_1T = core.transverse_mode_frequencies(a, D_ch).get("1T", 0.0)
    cand = []
    if f_1L > 0:
        cand.append(mode_growth_rate(f_1L, "1L", D_ch, L_ch, gas, n=n, tau_sens=tau_sens, coeffs=coeffs))
    if f_1T > 0:
        cand.append(mode_growth_rate(f_1T, "1T", D_ch, L_ch, gas, n=n, tau_sens=tau_sens, coeffs=coeffs))
    if not cand:
        nan = float("nan")
        return {"alpha_max": nan, "limiting_mode": None, "stable": False, "f_1L": f_1L, "f_1T": f_1T,
                "margin": nan, "margin_mode": None, "margin_worst_phase": nan, "worst_phase_mode": None}
    worst = max(cand, key=lambda m: m["alpha"])
    m_nom = min(cand, key=lambda m: m["margin"])
    m_wp = min(cand, key=lambda m: m["margin_worst_phase"])
    return {
        "alpha_max": float(worst["alpha"]), "limiting_mode": worst["mode"],
        "stable": bool(worst["alpha"] < 0.0), "f_1L": float(f_1L), "f_1T": float(f_1T),
        "margin": float(m_nom["margin"]), "margin_mode": m_nom["mode"],
        "margin_worst_phase": float(m_wp["margin_worst_phase"]), "worst_phase_mode": m_wp["mode"],
    }
