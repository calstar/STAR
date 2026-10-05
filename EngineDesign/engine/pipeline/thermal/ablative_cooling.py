"""Ablative liner: quasi-steady surface ablation along the real contour.

The char surface sits at the material's ablation temperature while it recedes (the
reinforcement's melt/decomposition bound; ``ablation_surface_temperature``). The gas-side
load at that temperature comes from engine.pipeline.thermal.gas_side (Bartz convection,
H2O/CO2 gas radiation), station by station. The mass consumed follows the quasi-steady
(Landau) balance

    q_net = m'' * [H_abl + cp * (T_s - T_init)]

the heat of ablation plus the sensible heat to bring virgin liner from its initial
temperature to the surface. Pyrolysis gas thickens the boundary layer: convection is
reduced by f(B) = 1/(1 + c B), B the pyrolysis flow over the chamber flow, or by the
legacy constant (1 - blowing_efficiency) when physics blowing is off.

The hot face exchanges radiation with the gas only; the gas term is net of the wall's own
emission, so nothing more is subtracted (an internal liner does not see the room).
"""

from __future__ import annotations

from typing import Dict, Optional

import numpy as np

from engine.pipeline.config_schemas import AblativeCoolingConfig
from engine.pipeline.constants import EPSILON_SMALL


def ablation_energy_per_mass(cfg: AblativeCoolingConfig, surface_temperature: float) -> float:
    """J per kg of liner consumed at a surface held at ``surface_temperature``."""
    return cfg.heat_of_ablation + cfg.specific_heat * max(surface_temperature - cfg.ambient_temperature, 0.0)


def blowing_reduction(cfg: AblativeCoolingConfig, pyrolysis_mdot: float, gas_mdot: Optional[float]) -> float:
    """Fraction of the convective flux left after pyrolysis-gas blowing."""
    if cfg.use_physics_based_blowing:
        if gas_mdot is None or gas_mdot <= 0:
            raise ValueError("physics-based blowing needs the chamber mass flow")
        B = pyrolysis_mdot / gas_mdot
        return max(1.0 / (1.0 + cfg.blowing_coefficient * B), cfg.blowing_min_reduction_factor)
    return 1.0 - float(np.clip(cfg.blowing_efficiency, 0.0, 1.0))


def liner_response(gas, contour, cfg: AblativeCoolingConfig, x_liner_end: float,
                   gas_mdot: float, surface_temperature: Optional[float] = None,
                   with_profile: bool = False) -> Dict[str, object]:
    """Quasi-steady ablation of the liner from the face to ``x_liner_end`` (throat frame).

    ``gas`` is a gas_side.HotGasState and ``contour`` a gas_side.WallContour. Returns the
    barrel-station numbers under the old keys (recession_rate, heat_flux_from_gas_*), the
    peak along the liner, the integrated heat to the liner, and with ``with_profile`` the
    whole-contour display arrays (segment_*).
    """
    from engine.pipeline.thermal.gas_side import profile

    Ts = float(cfg.ablation_surface_temperature if surface_temperature is None else surface_temperature)
    lined = (contour.x >= contour.x_face - 1e-12) & (contour.x <= x_liner_end + 1e-12)
    p = profile(gas, contour, Ts, cfg.surface_emissivity, mask=lined)
    dA = contour.area_elements()[lined] * float(np.clip(cfg.coverage_fraction, 0.0, 1.0))
    below_pyrolysis = Ts < cfg.pyrolysis_temperature
    E = ablation_energy_per_mass(cfg, Ts)
    q_conv, q_rad = np.maximum(p["q_conv"], 0.0), np.maximum(p["q_rad"], 0.0)
    f = 1.0
    for _ in range(50):
        q_net = np.maximum(f * q_conv + q_rad, 0.0)
        m_pyro = float(np.sum(q_net / E * dA))
        f_new = blowing_reduction(cfg, m_pyro, gas_mdot)
        if abs(f_new - f) < 1e-12:
            f = f_new
            break
        f = f_new
    q_net = np.maximum(f * q_conv + q_rad, 0.0) if not below_pyrolysis else np.zeros_like(q_conv)
    mass_flux = q_net / max(E, EPSILON_SMALL)
    rate = mass_flux / cfg.material_density
    Q = float(np.sum(q_net * dA))
    A = float(np.sum(dA))

    # Barrel reference station: mid-barrel (the old single-flux number, and the rate the
    # chamber diameter grows at).
    x_b = 0.5 * (contour.x_face + contour.x_cone_start)
    ib = int(np.argmin(np.abs(p["x"] - x_b)))
    ipk = int(np.argmax(rate))
    out: Dict[str, object] = {
        "enabled": True,
        "surface_temperature": Ts,
        "recession_rate": float(rate[ib]),
        "mass_flux": float(mass_flux[ib]),
        "effective_heat_flux": float(q_net[ib]),
        "heat_flux_from_gas_convective": float(q_conv[ib]),
        "heat_flux_from_gas_radiative": float(q_rad[ib]),
        "h_gas": float(p["h"][ib]),
        "adiabatic_wall_temperature": float(p["Taw"][ib]),
        "gas_emissivity": float(p["eps_gas"][ib]),
        "beam_length": float(p["beam_length"][ib]),
        "recession_rate_peak": float(rate[ipk]),
        "x_recession_peak": float(p["x"][ipk]),
        "heat_flux_from_gas_convective_peak": float(q_conv[ipk]),
        "heat_flux_from_gas_radiative_peak": float(q_rad[ipk]),
        "recession_rate_mean": float(np.sum(rate * dA) / A) if A > 0 else 0.0,
        "blowing_reduction": float(f),
        "energy_per_mass": float(E),
        "below_pyrolysis": bool(below_pyrolysis),
        "pyrolysis_temperature": float(cfg.pyrolysis_temperature),
        "cooling_power": Q,
        "heat_removed": Q,
        "coverage_area": A,
        "mass_flow": float(np.sum(mass_flux * dA)),
        "x_liner_end": float(x_liner_end),
        "leckner_pressure_correction_clamped": bool(np.any(p["leckner_clamped"])),
    }
    if with_profile:
        full = profile(gas, contour, Ts, cfg.surface_emissivity)
        qc, qr = np.maximum(full["q_conv"], 0.0), np.maximum(full["q_rad"], 0.0)
        out.update({
            "segment_x": full["x"].tolist(),
            "segment_r": full["r"].tolist(),
            "segment_q_conv": qc.tolist(),
            "segment_q_rad": qr.tolist(),
            "segment_q_incident": (qc + qr).tolist(),
            "segment_q_net": np.maximum(f * qc + qr, 0.0).tolist(),
            "segment_h": full["h"].tolist(),
            "segment_M": full["M"].tolist(),
            "throat_index": int(np.argmin(np.abs(full["x"]))),
            "profile_wall_temperature": Ts,
        })
    return out
