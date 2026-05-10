"""Coaxial injector model implementation."""

from __future__ import annotations

from typing import Tuple, Dict, Any

import numpy as np

from engine.pipeline.config_schemas import PintleEngineConfig, CoaxialInjectorConfig
from engine.pipeline.feed_loss import delta_p_feed
from engine.pipeline.thermal.regen_cooling import delta_p_regen_channels
from engine.core.discharge import cd_from_re, calculate_reynolds_number
from engine.core.spray import (
    momentum_flux_ratio,
    thrust_momentum_ratio,
    spray_angle_from_J,
    spray_angle_from_TMR,
    weber_number,
    ohnesorge_number,
    smd_lefebvre,
    tau_evap,
    xstar,
    check_spray_constraints,
)

from . import InjectorModel


def _annulus_area(inner_diameter: float, gap_thickness: float) -> float:
    outer_diameter = inner_diameter + 2.0 * gap_thickness
    return 0.25 * np.pi * (outer_diameter ** 2 - inner_diameter ** 2)


def _annulus_hydraulic_diameter(inner_diameter: float, gap_thickness: float) -> float:
    outer_diameter = inner_diameter + 2.0 * gap_thickness
    return outer_diameter - inner_diameter


class CoaxialInjector(InjectorModel):
    """Shear-coaxial injector solver (core oxidizer, annular fuel)."""

    injector_config: CoaxialInjectorConfig

    def __init__(self, engine_config: PintleEngineConfig):
        super().__init__(engine_config)
        injector_cfg = engine_config.injector
        if not isinstance(injector_cfg, CoaxialInjectorConfig):
            raise TypeError("CoaxialInjector requires CoaxialInjectorConfig")
        self.injector_config = injector_cfg

    def solve(
        self,
        P_tank_O: float,
        P_tank_F: float,
        Pc: float,
    ) -> Tuple[float, float, Dict[str, Any]]:
        config = self.engine_config
        geometry = self.injector_config.geometry

        discharge_O = config.discharge["oxidizer"]
        discharge_F = config.discharge["fuel"]
        feed_O = config.feed_system["oxidizer"]
        feed_F = config.feed_system["fuel"]
        spray_cfg = config.spray
        fluids = config.fluids

        rho_O = fluids["oxidizer"].density
        mu_O = fluids["oxidizer"].viscosity
        sigma_O = fluids["oxidizer"].surface_tension

        rho_F = fluids["fuel"].density
        mu_F = fluids["fuel"].viscosity
        sigma_F = fluids["fuel"].surface_tension

        # Geometrical quantities
        A_core = geometry.core.n_ports * np.pi * (geometry.core.d_port / 2.0) ** 2
        d_hyd_core = geometry.core.d_port  # Treat each port as round orifice

        A_annulus = _annulus_area(geometry.annulus.inner_diameter, geometry.annulus.gap_thickness)
        d_hyd_annulus = _annulus_hydraulic_diameter(geometry.annulus.inner_diameter, geometry.annulus.gap_thickness)

        mdot_O = 0.1
        mdot_F = 0.1

        max_iter = config.solver.closure.max_iterations
        Cd_reduction = config.solver.closure.Cd_reduction_factor
        Cd_O_eff = discharge_O.Cd_inf
        Cd_F_eff = discharge_F.Cd_inf

        diagnostics = {
            "iterations": 0,
            "constraints_satisfied": False,
            "violations": [],
            "J": None,
            "TMR": None,
            "theta": None,
            "We_O": None,
            "We_F": None,
            "D32_O": None,
            "D32_F": None,
            "x_star": None,
            "injector_type": "coaxial",
        }

        for iteration in range(max_iter):
            # Feed loss fixed-point iteration
            for feed_iter in range(3):
                delta_p_feed_O = delta_p_feed(mdot_O, rho_O, feed_O, P_tank_O)
                delta_p_feed_F_base = delta_p_feed(mdot_F, rho_F, feed_F, P_tank_F)
                if config.regen_cooling is not None and config.regen_cooling.enabled:
                    delta_p_regen = delta_p_regen_channels(
                        mdot_F,
                        rho_F,
                        mu_F,
                        config.regen_cooling,
                        P_tank_F,
                    )
                    delta_p_feed_F = delta_p_feed_F_base + delta_p_regen
                else:
                    delta_p_feed_F = delta_p_feed_F_base

                # CRITICAL: Calculate injector pressures AFTER feed loss calculation (always, not just in else block)
                P_inj_O = P_tank_O - delta_p_feed_O
                P_inj_F = P_tank_F - delta_p_feed_F

                if feed_iter < 2:
                    delta_p_inj_O = max(0.0, P_inj_O - Pc)
                    delta_p_inj_F = max(0.0, P_inj_F - Pc)

                    u_O_quick = np.sqrt(2 * delta_p_inj_O / rho_O) if delta_p_inj_O > 0 else 0.0
                    u_F_quick = np.sqrt(2 * delta_p_inj_F / rho_F) if delta_p_inj_F > 0 else 0.0

                    Re_O_quick = calculate_reynolds_number(rho_O, u_O_quick, d_hyd_core, mu_O)
                    Re_F_quick = calculate_reynolds_number(rho_F, u_F_quick, d_hyd_annulus, mu_F)

                    T_tank_O = 90.0
                    T_tank_F = 300.0
                    Cd_O_quick_base = cd_from_re(Re_O_quick, discharge_O, P_inlet=P_inj_O, T_inlet=T_tank_O)
                    Cd_F_quick_base = cd_from_re(Re_F_quick, discharge_F, P_inlet=P_inj_F, T_inlet=T_tank_F)
                    Cd_O_quick = min(Cd_O_quick_base, Cd_O_eff)
                    Cd_F_quick = min(Cd_F_quick_base, Cd_F_eff)

                    mdot_O = Cd_O_quick * A_core * np.sqrt(2 * rho_O * delta_p_inj_O)
                    mdot_F = Cd_F_quick * A_annulus * np.sqrt(2 * rho_F * delta_p_inj_F)

            delta_p_inj_O = max(0.0, P_inj_O - Pc)
            delta_p_inj_F = max(0.0, P_inj_F - Pc)

            if P_inj_O < Pc:
                mdot_O = 0.0
            if P_inj_F < Pc:
                mdot_F = 0.0

            # Reynolds-based Cd evaluation with inlet conditions
            u_O = mdot_O / (rho_O * A_core) if A_core > 0 else 0.0
            u_F_axial = mdot_F / (rho_F * A_annulus) if A_annulus > 0 else 0.0
            swirl_angle = np.deg2rad(geometry.annulus.swirl_angle)
            u_F = u_F_axial / np.cos(swirl_angle) if np.cos(swirl_angle) > 1e-6 else u_F_axial

            Re_O = calculate_reynolds_number(rho_O, u_O, d_hyd_core, mu_O)
            Re_F = calculate_reynolds_number(rho_F, u_F, d_hyd_annulus, mu_F)

            Cd_O_base = cd_from_re(Re_O, discharge_O, P_inlet=P_inj_O, T_inlet=90.0)
            Cd_F_base = cd_from_re(Re_F, discharge_F, P_inlet=P_inj_F, T_inlet=300.0)
            Cd_O = min(Cd_O_base, Cd_O_eff)
            Cd_F = min(Cd_F_base, Cd_F_eff)

            if delta_p_inj_O > 0:
                mdot_O = Cd_O * A_core * np.sqrt(2 * rho_O * delta_p_inj_O)
            else:
                mdot_O = 0.0

            if delta_p_inj_F > 0:
                mdot_F = Cd_F * A_annulus * np.sqrt(2 * rho_F * delta_p_inj_F)
            else:
                mdot_F = 0.0

            u_O = mdot_O / (rho_O * A_core) if A_core > 0 else 0.0
            u_F_axial = mdot_F / (rho_F * A_annulus) if A_annulus > 0 else 0.0
            u_F = u_F_axial / np.cos(swirl_angle) if np.cos(swirl_angle) > 1e-6 else u_F_axial

            J = momentum_flux_ratio(rho_O, u_O, rho_F, u_F_axial)
            MR = mdot_O / mdot_F if mdot_F > 0 else np.inf
            TMR = thrust_momentum_ratio(J, MR)

            if spray_cfg.spray_angle.model == "J":
                theta = spray_angle_from_J(J, spray_cfg.spray_angle.k, spray_cfg.spray_angle.n)
            else:
                theta = spray_angle_from_TMR(TMR)

            We_O = weber_number(rho_O, u_O, geometry.core.d_port, sigma_O)
            We_F = weber_number(rho_F, u_F, d_hyd_annulus, sigma_F)

            Oh_O = ohnesorge_number(mu_O, rho_O, sigma_O, geometry.core.d_port)
            Oh_F = ohnesorge_number(mu_F, rho_F, sigma_F, d_hyd_annulus)

            D32_O = smd_lefebvre(
                geometry.core.d_port,
                We_O,
                Oh_O,
                spray_cfg.smd.C,
                spray_cfg.smd.m,
                spray_cfg.smd.p,
            )
            D32_F = smd_lefebvre(
                d_hyd_annulus,
                We_F,
                Oh_F,
                spray_cfg.smd.C,
                spray_cfg.smd.m,
                spray_cfg.smd.p,
            )

            U_rel = np.sqrt(u_O ** 2 + u_F_axial ** 2)
            tau_evap_O = tau_evap(D32_O, spray_cfg.evaporation.K)
            x_star_O = xstar(U_rel, tau_evap_O)
            x_star_combined = max(x_star_O, xstar(U_rel, tau_evap(D32_F, spray_cfg.evaporation.K)))

            constraints_ok, violations = check_spray_constraints(We_O, We_F, x_star_combined, spray_cfg)

            diagnostics.update(
                {
                    "iterations": iteration + 1,
                    "constraints_satisfied": constraints_ok,
                    "violations": violations,
                    "J": J,
                    "TMR": TMR,
                    "theta": theta,
                    "We_O": We_O,
                    "We_F": We_F,
                    "D32_O": D32_O,
                    "D32_F": D32_F,
                    "x_star": x_star_combined,
                    "swirl_angle_deg": geometry.annulus.swirl_angle,
                    # Discharge coefficients
                    "Cd_O": float(Cd_O),
                    "Cd_F": float(Cd_F),
                }
            )

            if constraints_ok:
                break

            Cd_O_eff *= Cd_reduction
            Cd_O_eff = max(Cd_O_eff, discharge_O.Cd_min)
            Cd_F_eff *= Cd_reduction
            Cd_F_eff = max(Cd_F_eff, discharge_F.Cd_min)

        return mdot_O, mdot_F, diagnostics
