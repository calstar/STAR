"""Film cooling effectiveness model."""

from __future__ import annotations

from typing import Dict

import numpy as np

from engine.pipeline.config_schemas import FilmCoolingConfig


def compute_film_cooling(
    mdot_total: float,
    mdot_fuel: float,
    gas_props: Dict[str, float],
    film_config: FilmCoolingConfig,
    fuel_props,
) -> Dict[str, float]:
    """Compute film cooling effectiveness and adjusted heat-flux factor.

    Parameters
    ----------
    mdot_total : float
        Total propellant mass flow [kg/s].
    mdot_fuel : float
        Fuel mass flow [kg/s] (before allocating film fraction).
    gas_props : dict
        Dictionary of hot-gas and geometry properties (Tc, rho, velocity, h_hot_base,
        chamber length, circumference, hot surface area, etc.).
    film_config : FilmCoolingConfig
        Film cooling configuration object.
    fuel_props : FluidConfig
        Fuel fluid properties (density, cp, temperature).

    Returns
    -------
    dict
        Dictionary containing film effectiveness, remaining coolant flow, and
        heat-flux reduction factor.
    """
    Tc = float(gas_props.get("Tc", 0.0))
    if not film_config.enabled or mdot_total <= 0 or Tc <= 0:
        return {
            "enabled": False,
            "mass_fraction": 0.0,
            "mdot_film": 0.0,
            "mdot_available_for_regen": mdot_fuel,
            "effectiveness": 0.0,
            "heat_flux_factor": 1.0,
            "film_temperature": float(getattr(fuel_props, "temperature", 300.0)),
            "blowing_ratio": 0.0,
            "slot_velocity": 0.0,
            "heat_removed": 0.0,
            "heat_removed_surface": 0.0,
            "heat_removed_enthalpy": 0.0,
            "effective_gas_temperature": Tc,
        }

    mass_fraction = np.clip(film_config.mass_fraction, 0.0, 0.9)
    mdot_film = mass_fraction * mdot_fuel
    mdot_available = max(mdot_fuel - mdot_film, 1e-6)

    fuel_temperature = float(getattr(fuel_props, "temperature", 300.0))
    injection_temperature = (
        film_config.injection_temperature
        if film_config.injection_temperature is not None
        else fuel_temperature
    )

    rho_film = float(film_config.density_override or getattr(fuel_props, "density", 800.0))
    cp_film = float(film_config.cp_override or getattr(fuel_props, "specific_heat", 2000.0))

    rho_g = float(gas_props.get("rho", 1.0))
    velocity_g = float(gas_props.get("velocity", 1.0))
    circumference = float(gas_props.get("circumference", 0.0))
    chamber_length = float(gas_props.get("length", 0.0))
    hot_area = float(gas_props.get("area", 0.0))
    h_hot_base = float(gas_props.get("h_hot_base", 0.0))

    slot_height = max(film_config.slot_height, 1e-6)
    slot_area = max(circumference * slot_height, 1e-8)
    velocity_film = float(mdot_film / (rho_film * slot_area) if slot_area > 0 else 0.0)

    blowing_ratio = 0.0
    if rho_g * velocity_g > 0:
        blowing_ratio = (rho_film * velocity_film) / (rho_g * velocity_g)

    base_effectiveness = film_config.effectiveness_ref
    if blowing_ratio > 0:
        base_effectiveness *= (
            blowing_ratio / max(film_config.reference_blowing_ratio, 1e-6)
        ) ** film_config.blowing_exponent

    coverage_fraction = np.clip(film_config.apply_to_fraction_of_length, 0.0, 1.0)
    coverage_length = max(coverage_fraction * chamber_length, 1e-6)
    decay_length = max(film_config.decay_length, 1e-6)

    effectiveness_avg = base_effectiveness * (decay_length / coverage_length) * (
        1.0 - np.exp(-coverage_length / decay_length)
    )

    turbulence_intensity = float(gas_props.get("turbulence_intensity", film_config.turbulence_reference_intensity))
    turbulence_multiplier = 1.0
    if turbulence_intensity > 0 and film_config.turbulence_reference_intensity > 0:
        ratio = (turbulence_intensity / film_config.turbulence_reference_intensity) ** film_config.turbulence_exponent
        turbulence_multiplier = 1.0 / (1.0 + film_config.turbulence_sensitivity * ratio)
    turbulence_multiplier = float(np.clip(turbulence_multiplier, film_config.turbulence_min_multiplier, 1.0))

    effectiveness_avg *= turbulence_multiplier
    effectiveness_avg = float(np.clip(effectiveness_avg, 0.0, 0.95))

    heat_flux_factor = float(np.clip(1.0 - effectiveness_avg, 0.05, 1.0))

    delta_T = max(Tc - injection_temperature, 0.0)
    enthalpy_removed = mdot_film * cp_film * delta_T

    reference_wall_temp = film_config.reference_wall_temperature
    heat_flux_nominal = h_hot_base * max(Tc - reference_wall_temp, 0.0)
    covered_area = hot_area * coverage_fraction
    heat_removed_surface = effectiveness_avg * heat_flux_nominal * covered_area

    total_heat_removed = enthalpy_removed + heat_removed_surface

    effective_gas_temperature = Tc - effectiveness_avg * (Tc - injection_temperature)

    return {
        "enabled": True,
        "mass_fraction": mass_fraction,
        "mdot_film": mdot_film,
        "mdot_available_for_regen": mdot_available,
        "effectiveness": effectiveness_avg,
        "heat_flux_factor": heat_flux_factor,
        "film_temperature": injection_temperature,
        "effective_gas_temperature": effective_gas_temperature,
        "blowing_ratio": blowing_ratio,
        "slot_velocity": velocity_film,
        "heat_removed": float(total_heat_removed),
        "heat_removed_surface": float(heat_removed_surface),
        "heat_removed_enthalpy": float(enthalpy_removed),
        "coverage_length": float(coverage_length),
        "turbulence_intensity": turbulence_intensity,
        "turbulence_multiplier": turbulence_multiplier,
    }
