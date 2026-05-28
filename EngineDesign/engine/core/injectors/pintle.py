"""Pintle injector model implementation."""

from __future__ import annotations

from typing import Tuple, Dict, Any

import numpy as np

from engine.pipeline.config_schemas import PintleEngineConfig, PintleInjectorConfig
from engine.pipeline.feed_loss import delta_p_feed
from engine.pipeline.thermal.regen_cooling import delta_p_regen_channels
from engine.core.discharge import cd_from_re, calculate_reynolds_number, effective_cda
from engine.core.geometry import get_effective_areas, get_hydraulic_diameters
from engine.core.spray import (
    momentum_flux_ratio,
    thrust_momentum_ratio,
    spray_angle_from_J,
    spray_angle_from_TMR,
    weber_number,
    ohnesorge_number,
    smd_lefebvre,
    smd_pintle,
    tau_evap,
    xstar,
    check_spray_constraints,
)

from . import InjectorModel


def _smooth_cd_factor(we_val: float, we_min: float, cd_floor: float) -> float:
    """
    Continuous Cd reduction factor based on Weber number vs minimum threshold.

    Returns 1.0 when we_val >= we_min (no penalty).
    Returns cd_floor when we_val -> 0 (maximum penalty).
    Smooth cubic (smoothstep) interpolation in between — C1 continuous, no
    kink at we_min.

    Note: we_val is computed at nominal Cd (Pass 1), not at the corrected
    operating point. This means the penalty is an approximation — the actual
    We after correction is lower than we_val because lower Cd → lower velocity
    → lower We. This is intentional: we apply a smooth one-shot penalty rather
    than iterating to a consistent solution. The inconsistency is small and
    smooth across time steps, which is what eliminates the staircase.

    Parameters
    ----------
    we_val   : Weber number at nominal Cd (Pass 1 operating point)
    we_min   : minimum acceptable Weber number (e.g. 15.0)
    cd_floor : Cd fraction at zero We (explicit physical minimum, e.g. 0.74)
    """
    if we_val >= we_min:
        return 1.0
    t = max(we_val / we_min, 0.0)          # normalized [0, 1]
    t_smooth = t * t * (3.0 - 2.0 * t)    # smoothstep: 0→0, 1→1, zero derivative at endpoints
    return cd_floor + (1.0 - cd_floor) * t_smooth


class PintleInjector(InjectorModel):
    """Physically accurate pintle injector solver."""

    injector_config: PintleInjectorConfig

    def __init__(self, engine_config: PintleEngineConfig):
        super().__init__(engine_config)
        injector_cfg = engine_config.injector
        if not isinstance(injector_cfg, PintleInjectorConfig):
            raise TypeError("PintleInjector requires PintleInjectorConfig")
        self.injector_config = injector_cfg

    def solve(
        self,
        P_tank_O: float,
        P_tank_F: float,
        Pc: float,
    ) -> Tuple[float, float, Dict[str, Any]]:
        config = self.engine_config
        injector_geom = self.injector_config.geometry

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

        A_LOX, A_fuel = get_effective_areas(injector_geom)
        d_hyd_O, d_hyd_F = get_hydraulic_diameters(injector_geom)

        mdot_O_guess = 0.1
        mdot_F_guess = 0.1

        # cd_floor is the minimum Cd fraction under worst-case spray conditions.
        # Default 0.74 ≈ 0.95^6 for backward compatibility with the old iterative
        # loop, but decoupled from max_iter / Cd_reduction so it can be tuned
        # independently. Override per config via spray.weber.Cd_floor.
        cd_floor = spray_cfg.weber.get("Cd_floor", 0.74)

        # ---- PASS 1: nominal Cd to determine operating point ----
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
            "injector_type": "pintle",
            "turbulence_intensity_O": None,
            "turbulence_intensity_F": None,
            "turbulence_length_O": None,
            "turbulence_length_F": None,
            "turbulence_intensity_mix": None,
        }

        mdot_O = mdot_O_guess
        mdot_F = mdot_F_guess

        # Initialize feed losses (will be updated in feed_iter loop)
        delta_p_feed_O = 0.0
        delta_p_feed_F = 0.0

        for feed_iter in range(3):
            delta_p_feed_O = delta_p_feed(mdot_O, rho_O, feed_O, P_tank_O)
            delta_p_feed_F_base = delta_p_feed(mdot_F, rho_F, feed_F, P_tank_F)

            if delta_p_feed_O == 0.0 and mdot_O > 0.01:
                import warnings
                K0_val = feed_O.get('K0', 'N/A') if isinstance(feed_O, dict) else getattr(feed_O, 'K0', 'N/A')
                warnings.warn(f"[WARNING] LOX feed loss is 0.0 with mdot_O={mdot_O:.4f} kg/s. Check feed system config (K0={K0_val}, K_eff should be > 0).")

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

            P_inj_O = P_tank_O - delta_p_feed_O
            P_inj_F = P_tank_F - delta_p_feed_F

            if feed_iter < 2:
                delta_p_inj_O = max(0.0, P_inj_O - Pc)
                delta_p_inj_F = max(0.0, P_inj_F - Pc)

                u_O_quick = np.sqrt(2 * delta_p_inj_O / rho_O) if delta_p_inj_O > 0 else 0.0
                u_F_quick = np.sqrt(2 * delta_p_inj_F / rho_F) if delta_p_inj_F > 0 else 0.0

                Re_O_quick = calculate_reynolds_number(rho_O, u_O_quick, d_hyd_O, mu_O)
                Re_F_quick = calculate_reynolds_number(rho_F, u_F_quick, d_hyd_F, mu_F)

                T_tank_O = getattr(fluids["oxidizer"], 'temperature', 90.0)
                T_tank_F = getattr(fluids["fuel"], 'temperature', 300.0)
                CdA_O_quick = effective_cda(discharge_O, A_LOX, delta_p_inj_O, Re_O_quick, P_inlet=P_inj_O, T_inlet=T_tank_O)
                CdA_F_quick = effective_cda(discharge_F, A_fuel, delta_p_inj_F, Re_F_quick, P_inlet=P_inj_F, T_inlet=T_tank_F)
                if discharge_O.cda_fit_a is None:
                    CdA_O_quick = min(CdA_O_quick, Cd_O_eff * A_LOX)
                if discharge_F.cda_fit_a is None:
                    CdA_F_quick = min(CdA_F_quick, Cd_F_eff * A_fuel)

                mdot_O = CdA_O_quick * np.sqrt(2 * rho_O * delta_p_inj_O)
                mdot_F = CdA_F_quick * np.sqrt(2 * rho_F * delta_p_inj_F)

        delta_p_inj_O = max(0.0, P_inj_O - Pc)
        delta_p_inj_F = max(0.0, P_inj_F - Pc)

        if P_inj_F < Pc:
            mdot_F = 0.0
        if P_inj_O < Pc:
            mdot_O = 0.0

        u_O = mdot_O / (rho_O * A_LOX) if A_LOX > 0 else 0.0
        u_F = mdot_F / (rho_F * A_fuel) if A_fuel > 0 else 0.0

        Re_O = calculate_reynolds_number(rho_O, u_O, d_hyd_O, mu_O)
        Re_F = calculate_reynolds_number(rho_F, u_F, d_hyd_F, mu_F)

        # CRITICAL FIX: Use same temperature values as above, not hardcoded
        T_tank_O = getattr(fluids["oxidizer"], 'temperature', 90.0)
        T_tank_F = getattr(fluids["fuel"], 'temperature', 300.0)
        CdA_O = effective_cda(discharge_O, A_LOX, delta_p_inj_O, Re_O, P_inlet=P_inj_O, T_inlet=T_tank_O)
        CdA_F = effective_cda(discharge_F, A_fuel, delta_p_inj_F, Re_F, P_inlet=P_inj_F, T_inlet=T_tank_F)
        # In Re-based mode, cap at spray-constrained effective Cd
        using_fit_O = discharge_O.cda_fit_a is not None
        using_fit_F = discharge_F.cda_fit_a is not None
        if not using_fit_O:
            CdA_O = min(CdA_O, Cd_O_eff * A_LOX)
        if not using_fit_F:
            CdA_F = min(CdA_F, Cd_F_eff * A_fuel)
        # Expose effective Cd for diagnostics (CdA / geometric area)
        Cd_O_base = CdA_O / A_LOX if A_LOX > 0 else 0.0
        Cd_F_base = CdA_F / A_fuel if A_fuel > 0 else 0.0
        Cd_O = Cd_O_base
        Cd_F = Cd_F_base

        if delta_p_inj_O > 0:
            mdot_O = CdA_O * np.sqrt(2 * rho_O * delta_p_inj_O)
        else:
            mdot_O = 0.0

        if delta_p_inj_F > 0:
            mdot_F = CdA_F * np.sqrt(2 * rho_F * delta_p_inj_F)
        else:
            mdot_F = 0.0

        u_O = mdot_O / (rho_O * A_LOX) if A_LOX > 0 else 0.0
        u_F = mdot_F / (rho_F * A_fuel) if A_fuel > 0 else 0.0

        J = momentum_flux_ratio(rho_O, u_O, rho_F, u_F)
        MR = mdot_O / mdot_F if mdot_F > 0 else np.inf
        TMR = thrust_momentum_ratio(J, MR)

        if spray_cfg.spray_angle.model == "J":
            theta = spray_angle_from_J(J, spray_cfg.spray_angle.k, spray_cfg.spray_angle.n)
        else:
            theta = spray_angle_from_TMR(TMR)

        We_O = weber_number(rho_O, u_O, injector_geom.lox.d_orifice, sigma_O)
        We_F = weber_number(rho_F, u_F, d_hyd_F, sigma_F)

        Oh_O = ohnesorge_number(mu_O, rho_O, sigma_O, injector_geom.lox.d_orifice)
        Oh_F = ohnesorge_number(mu_F, rho_F, sigma_F, d_hyd_F)

        turbulence_intensity_O = 0.16 * (Re_O ** -0.125) if Re_O > 0 else 0.1
        turbulence_intensity_F = 0.16 * (Re_F ** -0.125) if Re_F > 0 else 0.1
        turbulence_intensity_O = float(np.clip(turbulence_intensity_O, 0.02, 0.3))
        turbulence_intensity_F = float(np.clip(turbulence_intensity_F, 0.02, 0.3))
        turbulence_length_O = 0.07 * d_hyd_O
        turbulence_length_F = 0.07 * d_hyd_F
        velocity_total = max(u_O + u_F, 1e-6)
        turbulence_intensity_mix = (
            (turbulence_intensity_O * u_O + turbulence_intensity_F * u_F) / velocity_total
        )
        turbulence_intensity_mix = float(np.clip(turbulence_intensity_mix, 0.02, 0.35))

        # PHYSICS-BASED PINTLE SMD: Use relative velocity and gap height
        # ----------------------------------------------------------------
        # V_rel = sqrt(u_O^2 + u_F^2) (orthogonal 90 deg impingement)
        # L_open = h_gap
        V_rel = float(np.sqrt(u_O**2 + u_F**2))  # Magnitude of relative velocity vector
        L_open = injector_geom.fuel.h_gap

        # Use physics-based correlation: SMD = C * L_open * We_rel^(-n) * (1 + B * Oh_f)^p
        # We_rel and Oh_f are computed inside smd_pintle using fuel properties (sheet)
        D32 = smd_pintle(
            L_open,
            V_rel,
            rho_F,
            mu_F,
            sigma_F,
            spray_cfg.pintle.C,
            spray_cfg.pintle.B,
            spray_cfg.pintle.n,
            spray_cfg.pintle.p,
        )

        # Assign coupled SMD to both streams
        D32_O = D32
        D32_F = D32

        if spray_cfg.use_turbulence_corrections:
            # For pintle physics mode, we typically RELY on V_rel (shear) as the primary mechanism
            # Turbulence gains might double-count or be less relevant than shear.
            # Per plan: Bypass or cap generic turbulence corrections for pintle SMD.
            # We log it but do not apply it to SMD.
            breakup_multiplier = 1.0  # Disabled for pintle mode
        else:
            breakup_multiplier = 1.0

        U_rel = np.sqrt(u_O ** 2 + u_F ** 2)
        tau_evap_O = tau_evap(D32_O, spray_cfg.evaporation.K)
        x_star_O = xstar(U_rel, tau_evap_O)
        x_star_combined = max(x_star_O, xstar(U_rel, tau_evap(D32_F, spray_cfg.evaporation.K)))

        if spray_cfg.use_turbulence_corrections:
            penetration_multiplier = 1.0 / (1.0 + spray_cfg.turbulence_penetration_gain * turbulence_intensity_mix)
            penetration_multiplier = float(np.clip(penetration_multiplier, 0.3, 1.0))
            x_star_combined *= penetration_multiplier
        else:
            penetration_multiplier = 1.0

        constraints_ok, violations = check_spray_constraints(We_O, We_F, x_star_combined, spray_cfg)

        # ---- SMOOTH CD CORRECTION (eliminates staircase discontinuity) -------------
        # The old binary iteration loop produced discrete Cd jumps as Weber numbers
        # drifted across We_min: 0 iterations (Cd = Cd_inf) vs N iterations
        # (Cd = Cd_inf * r^N). This caused staircase artifacts in mdot/thrust/OF.
        #
        # Replacement: compute a continuous penalty factor from the Pass 1 We values,
        # apply it once to Cd_eff, then recompute mdot (Pass 2). The penalty is C1
        # continuous (smoothstep), so no threshold crossings.
        #
        # Note: We_O/We_F here are from nominal-Cd conditions. The corrected
        # operating point will have lower We (lower Cd → lower velocity → lower We),
        # so constraints_ok and We diagnostics are intentionally approximate w.r.t.
        # the corrected state — a small, smooth inconsistency.
        We_min_val = spray_cfg.weber.get("We_min", 15.0)
        factor_O = _smooth_cd_factor(We_O, We_min_val, cd_floor)
        factor_F = _smooth_cd_factor(We_F, We_min_val, cd_floor)

        # x_star: x_star >= x_limit is a violation (evaporation path too long).
        # Penalty scales with excess; asymptotes to cd_floor as x_star → ∞
        # (no recovery back to 1.0 above the threshold — intentional conservative
        # behavior that differs from the We case).
        if spray_cfg.evaporation.use_constraint:
            x_lim = spray_cfg.evaporation.x_star_limit
            if x_star_combined > x_lim:
                t = max(x_lim / x_star_combined, 0.0)
                t_smooth = t * t * (3.0 - 2.0 * t)
                x_factor = cd_floor + (1.0 - cd_floor) * t_smooth
                factor_O = min(factor_O, x_factor)
                factor_F = min(factor_F, x_factor)

        Cd_O_eff = max(discharge_O.Cd_inf * factor_O, discharge_O.Cd_min)
        Cd_F_eff = max(discharge_F.Cd_inf * factor_F, discharge_F.Cd_min)

        # ---- PASS 2: recompute mdot/Cd with corrected cap ----
        # Reuses delta_p_inj_O/F from Pass 1; feed losses don't change enough at
        # this correction magnitude to warrant re-running the full feed_iter loop.
        if factor_O < 1.0 or factor_F < 1.0:
            if not using_fit_O:
                CdA_O = min(CdA_O, Cd_O_eff * A_LOX)
            if not using_fit_F:
                CdA_F = min(CdA_F, Cd_F_eff * A_fuel)
            Cd_O = CdA_O / A_LOX if A_LOX > 0 else 0.0
            Cd_F = CdA_F / A_fuel if A_fuel > 0 else 0.0
            mdot_O = CdA_O * np.sqrt(2 * rho_O * delta_p_inj_O) if delta_p_inj_O > 0 else 0.0
            mdot_F = CdA_F * np.sqrt(2 * rho_F * delta_p_inj_F) if delta_p_inj_F > 0 else 0.0
        # ---------------------------------------------------------------------------

        # CRITICAL: Recalculate feed losses one final time with converged mass flows
        # to ensure diagnostics have the correct final values
        delta_p_feed_O_final = delta_p_feed(mdot_O, rho_O, feed_O, P_tank_O)
        delta_p_feed_F_base_final = delta_p_feed(mdot_F, rho_F, feed_F, P_tank_F)
        if config.regen_cooling is not None and config.regen_cooling.enabled:
            delta_p_regen_final = delta_p_regen_channels(
                mdot_F,
                rho_F,
                mu_F,
                config.regen_cooling,
                P_tank_F,
            )
            delta_p_feed_F_final = delta_p_feed_F_base_final + delta_p_regen_final
        else:
            delta_p_feed_F_final = delta_p_feed_F_base_final

        diagnostics.update(
            {
                "iterations": 1,
                "constraints_satisfied": constraints_ok,
                "violations": violations,
                "J": J,
                "TMR": TMR,
                "theta": theta,
                "We_O": We_O,
                "We_F": We_F,
                "V_rel": V_rel,
                "L_open": L_open,
                "D32_O": D32_O,
                "D32_F": D32_F,
                "x_star": x_star_combined,
                "turbulence_intensity_O": turbulence_intensity_O,
                "turbulence_intensity_F": turbulence_intensity_F,
                "turbulence_length_O": turbulence_length_O,
                "turbulence_length_F": turbulence_length_F,
                "turbulence_intensity_mix": turbulence_intensity_mix,
                "breakup_multiplier": breakup_multiplier,
                "penetration_multiplier": penetration_multiplier,
                # Injector velocities (from Pass 1 nominal operating point)
                "u_O": float(u_O),
                "u_F": float(u_F),
                # Injector pressure diagnostics
                "P_injector_O": float(P_inj_O),
                "P_injector_F": float(P_inj_F),
                "delta_p_injector_O": float(delta_p_inj_O),
                "delta_p_injector_F": float(delta_p_inj_F),
                # CRITICAL: Use final calculated feed losses, not loop values
                "delta_p_feed_O": float(delta_p_feed_O_final),
                "delta_p_feed_F": float(delta_p_feed_F_final),
                # Discharge coefficients (reflect Pass 2 correction if applied)
                "Cd_O": float(Cd_O),
                "Cd_F": float(Cd_F),
            }
        )

        return mdot_O, mdot_F, diagnostics
