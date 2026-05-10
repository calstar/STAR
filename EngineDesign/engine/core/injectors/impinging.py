"""Impinging injector model implementation."""

from __future__ import annotations

from typing import Tuple, Dict, Any

import numpy as np

from engine.pipeline.config_schemas import PintleEngineConfig, ImpingingInjectorConfig
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


class ImpingingInjector(InjectorModel):
    """Twin-jet impinging injector solver."""

    injector_config: ImpingingInjectorConfig

    def __init__(self, engine_config: PintleEngineConfig):
        super().__init__(engine_config)
        injector_cfg = engine_config.injector
        if not isinstance(injector_cfg, ImpingingInjectorConfig):
            raise TypeError("ImpingingInjector requires ImpingingInjectorConfig")
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

        A_O = geometry.oxidizer.n_elements * np.pi * (geometry.oxidizer.d_jet / 2.0) ** 2
        A_F = geometry.fuel.n_elements * np.pi * (geometry.fuel.d_jet / 2.0) ** 2
        d_hyd_O = geometry.oxidizer.d_jet
        d_hyd_F = geometry.fuel.d_jet

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
            "injector_type": "impinging",
        }

        imp_angle_rad = np.deg2rad((geometry.oxidizer.impingement_angle + geometry.fuel.impingement_angle) / 2.0)

        for iteration in range(max_iter):
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

                    Re_O_quick = calculate_reynolds_number(rho_O, u_O_quick, d_hyd_O, mu_O)
                    Re_F_quick = calculate_reynolds_number(rho_F, u_F_quick, d_hyd_F, mu_F)

                    T_tank_O = 90.0
                    T_tank_F = 300.0
                    Cd_O_quick_base = cd_from_re(Re_O_quick, discharge_O, P_inlet=P_inj_O, T_inlet=T_tank_O)
                    Cd_F_quick_base = cd_from_re(Re_F_quick, discharge_F, P_inlet=P_inj_F, T_inlet=T_tank_F)
                    Cd_O_quick = min(Cd_O_quick_base, Cd_O_eff)
                    Cd_F_quick = min(Cd_F_quick_base, Cd_F_eff)

                    mdot_O = Cd_O_quick * A_O * np.sqrt(2 * rho_O * delta_p_inj_O)
                    mdot_F = Cd_F_quick * A_F * np.sqrt(2 * rho_F * delta_p_inj_F)

            delta_p_inj_O = max(0.0, P_inj_O - Pc)
            delta_p_inj_F = max(0.0, P_inj_F - Pc)

            if P_inj_O < Pc:
                mdot_O = 0.0
            if P_inj_F < Pc:
                mdot_F = 0.0

            u_O = mdot_O / (rho_O * A_O) if A_O > 0 else 0.0
            u_F = mdot_F / (rho_F * A_F) if A_F > 0 else 0.0

            Re_O = calculate_reynolds_number(rho_O, u_O, d_hyd_O, mu_O)
            Re_F = calculate_reynolds_number(rho_F, u_F, d_hyd_F, mu_F)

            Cd_O_base = cd_from_re(Re_O, discharge_O, P_inlet=P_inj_O, T_inlet=90.0)
            Cd_F_base = cd_from_re(Re_F, discharge_F, P_inlet=P_inj_F, T_inlet=300.0)
            Cd_O = min(Cd_O_base, Cd_O_eff)
            Cd_F = min(Cd_F_base, Cd_F_eff)

            if delta_p_inj_O > 0:
                mdot_O = Cd_O * A_O * np.sqrt(2 * rho_O * delta_p_inj_O)
            else:
                mdot_O = 0.0

            if delta_p_inj_F > 0:
                mdot_F = Cd_F * A_F * np.sqrt(2 * rho_F * delta_p_inj_F)
            else:
                mdot_F = 0.0

            u_O = mdot_O / (rho_O * A_O) if A_O > 0 else 0.0
            u_F = mdot_F / (rho_F * A_F) if A_F > 0 else 0.0

            # Impingement results in sheet velocity roughly the vector sum
            u_sheet = np.sqrt(u_O ** 2 + u_F ** 2 - 2 * u_O * u_F * np.cos(imp_angle_rad))

            J = momentum_flux_ratio(rho_O, u_O, rho_F, u_F)
            MR = mdot_O / mdot_F if mdot_F > 0 else np.inf
            TMR = thrust_momentum_ratio(J, MR)

            if spray_cfg.spray_angle.model == "J":
                theta = spray_angle_from_J(J, spray_cfg.spray_angle.k, spray_cfg.spray_angle.n)
            else:
                theta = spray_angle_from_TMR(TMR)

            We_O = weber_number(rho_O, u_O, geometry.oxidizer.d_jet, sigma_O)
            We_F = weber_number(rho_F, u_F, geometry.fuel.d_jet, sigma_F)

            Oh_O = ohnesorge_number(mu_O, rho_O, sigma_O, geometry.oxidizer.d_jet)
            Oh_F = ohnesorge_number(mu_F, rho_F, sigma_F, geometry.fuel.d_jet)

            D32_O = smd_lefebvre(
                geometry.oxidizer.d_jet,
                We_O,
                Oh_O,
                spray_cfg.smd.C,
                spray_cfg.smd.m,
                spray_cfg.smd.p,
            )
            D32_F = smd_lefebvre(
                geometry.fuel.d_jet,
                We_F,
                Oh_F,
                spray_cfg.smd.C,
                spray_cfg.smd.m,
                spray_cfg.smd.p,
            )

            tau_evap_O = tau_evap(D32_O, spray_cfg.evaporation.K)
            tau_evap_F = tau_evap(D32_F, spray_cfg.evaporation.K)
            x_star = max(xstar(u_sheet, tau_evap_O), xstar(u_sheet, tau_evap_F))

            constraints_ok, violations = check_spray_constraints(We_O, We_F, x_star, spray_cfg)

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
                    "x_star": x_star,
                    "impingement_angle_deg": np.rad2deg(imp_angle_rad),
                    # Discharge coefficients
                    "Cd_O": float(Cd_O),
                    "Cd_F": float(Cd_F),
                }
            )

            if constraints_ok:
                break

            Cd_O_eff *= Cd_reduction
            Cd_F_eff *= Cd_reduction
            Cd_O_eff = max(Cd_O_eff, discharge_O.Cd_min)
            Cd_F_eff = max(Cd_F_eff, discharge_F.Cd_min)

        return mdot_O, mdot_F, diagnostics
