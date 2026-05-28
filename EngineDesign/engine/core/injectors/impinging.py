"""Impinging injector model implementation."""

from __future__ import annotations

import logging
import os
from typing import Tuple, Dict, Any

import numpy as np

_LOG = logging.getLogger(__name__)
_print_raw = os.environ.get("ENGINE_PRINT_IMPINGING_FEED_CLOSURE", "")
_PRINT_FEED_ORIFICE_CLOSURE = _print_raw != "" and str(_print_raw).lower() not in ("0", "false", "no")
_FEED_ORIFICE_FP_TOL = 1e-6
_FEED_ORIFICE_FP_MAX_ITER = 150
_FEED_ORIFICE_CD_INNER_MAX = 120
_FEED_ORIFICE_CD_INNER_TOL = 1e-12
# Under-relaxation for the feed-loss ⇄ Bernoulli fixed point. A full Gauss–Seidel step can limit-cycle
# when quadratic feed losses interact with choked-orifice flow (seen in ``impinging_smoke``).
_FEED_ORIFICE_RELAX = 0.35

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
from engine.core.injectors.flow_capacity import (
    effective_flow_areas_from_cd,
    merge_effective_area_warnings,
)


def momentum_ratio_R_from_bulk_velocities(
    rho_O: float,
    rho_F: float,
    v_O_bulk: float,
    v_F_bulk: float,
) -> float:
    """Jet momentum ratio used by Layer 1: sqrt(rho_O*v_O^2 / (rho_F*v_F^2)).

    ``v_*_bulk`` are bulk speeds per stream: mdot / (rho * n_elements * A_jet).
    """
    if (
        rho_O <= 0
        or rho_F <= 0
        or not np.isfinite(v_O_bulk)
        or not np.isfinite(v_F_bulk)
        or v_F_bulk == 0.0
    ):
        return float("nan")
    num_mom = rho_O * v_O_bulk ** 2
    den_mom = rho_F * v_F_bulk ** 2
    if den_mom <= 0 or num_mom < 0:
        return float("nan")
    return float(np.sqrt(num_mom / den_mom))


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

        # Inlet temperatures for Cd(Re): match pintle — use fluid properties from config when set
        T_tank_O = getattr(fluids["oxidizer"], "temperature", 90.0)
        T_tank_F = getattr(fluids["fuel"], "temperature", 300.0)

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
            "turbulence_intensity_O": None,
            "turbulence_intensity_F": None,
            "turbulence_length_O": None,
            "turbulence_length_F": None,
            "turbulence_intensity_mix": None,
        }

        # Typical opposing doublet: each side's ``impingement_angle`` is measured from chamber axis toward
        # the impingement plane; separation between jet centerlines is θ_O + θ_F (schema: included angle per stream).
        _imp_sep_deg = float(geometry.oxidizer.impingement_angle + geometry.fuel.impingement_angle)
        _imp_sep_deg = float(np.clip(_imp_sep_deg, 1.0, 179.0))
        imp_angle_rad = np.deg2rad(_imp_sep_deg)

        def _injector_turbulence_fields(uo: float, uf: float) -> Dict[str, float]:
            """Same Reynolds-based turbulence model as pintle (shear-layer mixing intensity)."""
            Re_Oloc = calculate_reynolds_number(rho_O, uo, d_hyd_O, mu_O)
            Re_Floc = calculate_reynolds_number(rho_F, uf, d_hyd_F, mu_F)
            ti_O = 0.16 * (Re_Oloc ** -0.125) if Re_Oloc > 0 else 0.1
            ti_F = 0.16 * (Re_Floc ** -0.125) if Re_Floc > 0 else 0.1
            ti_O = float(np.clip(ti_O, 0.02, 0.3))
            ti_F = float(np.clip(ti_F, 0.02, 0.3))
            tl_O = float(0.07 * d_hyd_O)
            tl_F = float(0.07 * d_hyd_F)
            velocity_total = max(uo + uf, 1e-6)
            ti_mix = (ti_O * uo + ti_F * uf) / velocity_total
            ti_mix = float(np.clip(ti_mix, 0.02, 0.35))
            return {
                "turbulence_intensity_O": ti_O,
                "turbulence_intensity_F": ti_F,
                "turbulence_length_O": tl_O,
                "turbulence_length_F": tl_F,
                "turbulence_intensity_mix": ti_mix,
            }

        def _converge_feed_orifice_coupling(
            mdot_o0: float,
            mdot_f0: float,
            cd_eff_o: float,
            cd_eff_f: float,
        ) -> Tuple[
            float,
            float,
            float,
            float,
            float,
            float,
            float,
            float,
            float,
            float,
            int,
        ]:
            """Feed loss ⇄ inlet pressure ⇄ Bernoulli mdot until fixed point (per spray outer iteration).

            Sequential update: Δp_feed(ṁ) → P_inj → Δp_inj → Cd(Re(u)) → ṁ′ = Cd A √(2 ρ Δp_inj).

            Returns
            -------
            mdot_o, mdot_f, cd_o, cd_f, Pi_o, Pi_f, dpf_o, dpf_f, dpi_o, dpi_f, fp_iters
            """

            def _bern_mdot_with_cd_iterate(
                mdot_seed: float,
                delta_p_inj: float,
                Pi_inj: float,
                rho_i: float,
                area_i: float,
                d_hyd_local: float,
                mu_local: float,
                discharge_local,
                Tin: float,
                cd_cap: float,
            ) -> Tuple[float, float]:
                """For fixed inlet head Δp_inj(P_inj,Pc): ṁ = Cd(Re(ṁ)) A √(2ρ Δp_inj) to numerical tolerance."""
                if delta_p_inj <= 0:
                    Cd_0 = float(
                        min(
                            cd_from_re(0.0, discharge_local, P_inlet=Pi_inj, T_inlet=Tin),
                            cd_cap,
                        )
                    )
                    return 0.0, Cd_0

                cd_lo = float(
                    min(
                        cd_from_re(0.0, discharge_local, P_inlet=Pi_inj, T_inlet=Tin),
                        cd_cap,
                    )
                )
                m = float(mdot_seed) if mdot_seed > 1e-18 else float(cd_lo * area_i * np.sqrt(2.0 * rho_i * delta_p_inj))
                Cd_out = cd_lo

                for _cin in range(1, _FEED_ORIFICE_CD_INNER_MAX + 1):
                    m_was = float(m)
                    u_loc = m / (rho_i * area_i) if area_i > 0 else 0.0
                    Re_loc = calculate_reynolds_number(rho_i, u_loc, d_hyd_local, mu_local)
                    Cd_out = float(
                        min(
                            cd_from_re(Re_loc, discharge_local, P_inlet=Pi_inj, T_inlet=Tin),
                            cd_cap,
                        )
                    )
                    m = float(Cd_out * area_i * np.sqrt(2.0 * rho_i * delta_p_inj))
                    inn_rel = abs(m - m_was) / max(abs(m_was), 1e-18)
                    if inn_rel < _FEED_ORIFICE_CD_INNER_TOL:
                        break
                    if _cin == _FEED_ORIFICE_CD_INNER_MAX:
                        _LOG.warning(
                            "impinging injector: Cd–Bernoulli inner iterations hit "
                            f"{_FEED_ORIFICE_CD_INNER_MAX}; inn_rel={inn_rel:.3e}"
                        )

                return float(m), float(Cd_out)

            mo = float(mdot_o0)
            mf = float(mdot_f0)
            dpi_o = dpi_f = 0.0
            dpf_o = dpf_f = 0.0
            Pi_o = Pi_f = P_tank_O
            Cdo = Cdf = 0.0

            for fp_it in range(1, _FEED_ORIFICE_FP_MAX_ITER + 1):
                mo_prev, mf_prev = mo, mf

                dpf_o = delta_p_feed(mo, rho_O, feed_O, P_tank_O)
                dpf_f_base = delta_p_feed(mf, rho_F, feed_F, P_tank_F)
                if config.regen_cooling is not None and config.regen_cooling.enabled:
                    dpf_reg = delta_p_regen_channels(
                        mf,
                        rho_F,
                        mu_F,
                        config.regen_cooling,
                        P_tank_F,
                    )
                    dpf_f = dpf_f_base + dpf_reg
                else:
                    dpf_f = dpf_f_base

                Pi_o = float(P_tank_O - dpf_o)
                Pi_f = float(P_tank_F - dpf_f)
                dpi_o = max(0.0, Pi_o - Pc)
                dpi_f = max(0.0, Pi_f - Pc)

                if Pi_o < Pc:
                    mo_new = 0.0
                    Cdo = float(min(cd_from_re(0.0, discharge_O, P_inlet=Pi_o, T_inlet=T_tank_O), cd_eff_o))
                else:
                    mo_new, Cdo = _bern_mdot_with_cd_iterate(
                        mo,
                        dpi_o,
                        Pi_o,
                        rho_O,
                        A_O,
                        d_hyd_O,
                        mu_O,
                        discharge_O,
                        T_tank_O,
                        cd_eff_o,
                    )

                if Pi_f < Pc:
                    mf_new = 0.0
                    Cdf = float(min(cd_from_re(0.0, discharge_F, P_inlet=Pi_f, T_inlet=T_tank_F), cd_eff_f))
                else:
                    mf_new, Cdf = _bern_mdot_with_cd_iterate(
                        mf,
                        dpi_f,
                        Pi_f,
                        rho_F,
                        A_F,
                        d_hyd_F,
                        mu_F,
                        discharge_F,
                        T_tank_F,
                        cd_eff_f,
                    )

                w = float(_FEED_ORIFICE_RELAX)
                if not (np.isfinite(w) and 0.0 < w <= 1.0):
                    w = 0.35
                mo = float(mo_prev + w * (mo_new - mo_prev))
                mf = float(mf_prev + w * (mf_new - mf_prev))

                # Consistent feed/injector heads at the relaxed iterate (also updates returned dpi_*).
                dpf_o = delta_p_feed(mo, rho_O, feed_O, P_tank_O)
                dpf_f_base = delta_p_feed(mf, rho_F, feed_F, P_tank_F)
                if config.regen_cooling is not None and config.regen_cooling.enabled:
                    dpf_f = dpf_f_base + delta_p_regen_channels(
                        mf,
                        rho_F,
                        mu_F,
                        config.regen_cooling,
                        P_tank_F,
                    )
                else:
                    dpf_f = dpf_f_base
                Pi_o = float(P_tank_O - dpf_o)
                Pi_f = float(P_tank_F - dpf_f)
                dpi_o = max(0.0, Pi_o - Pc)
                dpi_f = max(0.0, Pi_f - Pc)

                if Pi_o < Pc:
                    Cdo = float(min(cd_from_re(0.0, discharge_O, P_inlet=Pi_o, T_inlet=T_tank_O), cd_eff_o))
                else:
                    u_o2 = mo / (rho_O * A_O) if A_O > 0 else 0.0
                    Re_o2 = calculate_reynolds_number(rho_O, u_o2, d_hyd_O, mu_O)
                    Cdo = float(min(cd_from_re(Re_o2, discharge_O, P_inlet=Pi_o, T_inlet=T_tank_O), cd_eff_o))
                if Pi_f < Pc:
                    Cdf = float(min(cd_from_re(0.0, discharge_F, P_inlet=Pi_f, T_inlet=T_tank_F), cd_eff_f))
                else:
                    u_f2 = mf / (rho_F * A_F) if A_F > 0 else 0.0
                    Re_f2 = calculate_reynolds_number(rho_F, u_f2, d_hyd_F, mu_F)
                    Cdf = float(min(cd_from_re(Re_f2, discharge_F, P_inlet=Pi_f, T_inlet=T_tank_F), cd_eff_f))

                # Symmetric relative residual (pure ``|Δ|/|prev|`` blows up when ṁ crosses ~0).
                den_o = max(abs(mo_prev), abs(mo), 1e-18)
                den_f = max(abs(mf_prev), abs(mf), 1e-18)
                rel_o = abs(mo - mo_prev) / den_o
                rel_f = abs(mf - mf_prev) / den_f

                if rel_o < _FEED_ORIFICE_FP_TOL and rel_f < _FEED_ORIFICE_FP_TOL:
                    break
                if fp_it == _FEED_ORIFICE_FP_MAX_ITER:
                    _LOG.warning(
                        "impinging injector: feed-orifice coupling hit max iterations "
                        f"({_FEED_ORIFICE_FP_MAX_ITER}); rel errors O={rel_o:.3e} F={rel_f:.3e}"
                    )

            mdot_bn_o = float(Cdo * A_O * np.sqrt(2.0 * rho_O * dpi_o)) if dpi_o > 0 else 0.0
            mdot_bn_f = float(Cdf * A_F * np.sqrt(2.0 * rho_F * dpi_f)) if dpi_f > 0 else 0.0

            _LOG.debug(
                "impinging feed-orifice closure: fp_iters=%d mdot_solver_O=%s mdot_from_Bernoulli_O=%s "
                "mdot_solver_F=%s mdot_from_Bernoulli_F=%s",
                fp_it,
                repr(mo),
                repr(mdot_bn_o),
                repr(mf),
                repr(mdot_bn_f),
            )
            if _PRINT_FEED_ORIFICE_CLOSURE:
                print(
                    "impinging feed-orifice closure",
                    f"fp_iters={fp_it}",
                    f"mdot_solver_O={mo}",
                    f"mdot_from_Bernoulli_O={mdot_bn_o}",
                    f"mdot_solver_F={mf}",
                    f"mdot_from_Bernoulli_F={mdot_bn_f}",
                )

            return mo, mf, Cdo, Cdf, Pi_o, Pi_f, dpf_o, dpf_f, dpi_o, dpi_f, fp_it

        feed_orifice_fp_last = 0

        for iteration in range(max_iter):
            mdot_O, mdot_F, Cd_O, Cd_F, P_inj_O, P_inj_F, delta_p_feed_O, delta_p_feed_F, delta_p_inj_O, delta_p_inj_F, feed_orifice_fp_last = _converge_feed_orifice_coupling(
                mdot_O,
                mdot_F,
                Cd_O_eff,
                Cd_F_eff,
            )

            u_O = mdot_O / (rho_O * A_O) if A_O > 0 else 0.0
            u_F = mdot_F / (rho_F * A_F) if A_F > 0 else 0.0

            # Impingement results in sheet velocity roughly the vector sum
            u_sheet = np.sqrt(u_O ** 2 + u_F ** 2 - 2 * u_O * u_F * np.cos(imp_angle_rad))
            turb_fields = _injector_turbulence_fields(u_O, u_F)

            # Weber numbers for the Lefebvre-style correlation: use the LIQUID density (as in the correlation),
            # but blend in sheet kinetic energy so impingement physics affects breakup without switching density phases.
            # This avoids the previous failure mode where tiny liquid-We produced unrealistically small D32, and also
            # avoids the opposite failure mode where gas-density We + tiny D32 destroyed chamber closure.
            alpha_sheet = 0.35
            u_eff_O = float(np.sqrt(max(u_O, 0.0) ** 2 + (alpha_sheet * max(u_sheet, 0.0)) ** 2))
            u_eff_F = float(np.sqrt(max(u_F, 0.0) ** 2 + (alpha_sheet * max(u_sheet, 0.0)) ** 2))

            J = momentum_flux_ratio(rho_O, u_O, rho_F, u_F)
            MR = mdot_O / mdot_F if mdot_F > 0 else np.inf
            TMR = thrust_momentum_ratio(J, MR)

            if spray_cfg.spray_angle.model == "J":
                theta = spray_angle_from_J(J, spray_cfg.spray_angle.k, spray_cfg.spray_angle.n)
            else:
                theta = spray_angle_from_TMR(TMR)

            We_O = weber_number(rho_O, u_eff_O, geometry.oxidizer.d_jet, sigma_O)
            We_F = weber_number(rho_F, u_eff_F, geometry.fuel.d_jet, sigma_F)

            _we_cap = getattr(spray_cfg.smd, "we_corr_max", None)
            if _we_cap is not None and np.isfinite(float(_we_cap)) and float(_we_cap) > 0:
                We_O_smd = float(min(We_O, float(_we_cap)))
                We_F_smd = float(min(We_F, float(_we_cap)))
            else:
                We_O_smd = float(We_O)
                We_F_smd = float(We_F)

            Oh_O = ohnesorge_number(mu_O, rho_O, sigma_O, geometry.oxidizer.d_jet)
            Oh_F = ohnesorge_number(mu_F, rho_F, sigma_F, geometry.fuel.d_jet)

            D32_O = smd_lefebvre(
                geometry.oxidizer.d_jet,
                We_O_smd,
                Oh_O,
                spray_cfg.smd.C,
                spray_cfg.smd.m,
                spray_cfg.smd.p,
            )
            D32_F = smd_lefebvre(
                geometry.fuel.d_jet,
                We_F_smd,
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
                    "u_eff_O": float(u_eff_O),
                    "u_eff_F": float(u_eff_F),
                    "We_O": We_O,
                    "We_F": We_F,
                    "We_O_smd": We_O_smd,
                    "We_F_smd": We_F_smd,
                    "D32_O": D32_O,
                    "D32_F": D32_F,
                    "x_star": x_star,
                    "impingement_angle_deg": np.rad2deg(imp_angle_rad),
                    "V_rel": float(u_sheet),
                    "breakup_multiplier": 1.0,
                    "penetration_multiplier": 1.0,
                    **turb_fields,
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

        # Diagnostics must match last feed–orifice coupling (recomputing from ṁ duplicates float path and drifted Cd).
        delta_p_feed_O_final = float(delta_p_feed_O)
        delta_p_feed_F_final = float(delta_p_feed_F)
        P_inj_O_final = float(P_inj_O)
        P_inj_F_final = float(P_inj_F)
        delta_p_inj_O_final = float(delta_p_inj_O)
        delta_p_inj_F_final = float(delta_p_inj_F)

        mdot_from_bernoulli_O = (
            float(Cd_O * A_O * np.sqrt(2.0 * rho_O * delta_p_inj_O_final))
            if delta_p_inj_O_final > 0
            else 0.0
        )
        mdot_from_bernoulli_F = (
            float(Cd_F * A_F * np.sqrt(2.0 * rho_F * delta_p_inj_F_final))
            if delta_p_inj_F_final > 0
            else 0.0
        )

        u_O_final = mdot_O / (rho_O * A_O) if A_O > 0 else 0.0
        u_F_final = mdot_F / (rho_F * A_F) if A_F > 0 else 0.0
        u_sheet_final = float(
            np.sqrt(
                u_O_final ** 2
                + u_F_final ** 2
                - 2 * u_O_final * u_F_final * np.cos(imp_angle_rad)
            )
        )
        turb_final = _injector_turbulence_fields(u_O_final, u_F_final)

        # Momentum-balance metric: v = mdot / (rho * n_elements * A_jet), A_jet = pi*(d_jet/2)^2
        n_O = max(1, int(geometry.oxidizer.n_elements))
        n_F = max(1, int(geometry.fuel.n_elements))
        djo = float(geometry.oxidizer.d_jet)
        djf = float(geometry.fuel.d_jet)
        A_jet_O = np.pi * (djo / 2.0) ** 2
        A_jet_F = np.pi * (djf / 2.0) ** 2
        denom_O = rho_O * float(n_O) * A_jet_O
        denom_F = rho_F * float(n_F) * A_jet_F
        v_O_bulk = mdot_O / denom_O if denom_O > 0 else np.nan
        v_F_bulk = mdot_F / denom_F if denom_F > 0 else np.nan
        momentum_ratio_R = momentum_ratio_R_from_bulk_velocities(
            float(rho_O), float(rho_F), float(v_O_bulk), float(v_F_bulk)
        )

        mom_update: Dict[str, Any] = {
            "A_jet_O": float(A_jet_O),
            "A_jet_F": float(A_jet_F),
            "momentum_ratio_n_elements_O": int(n_O),
            "momentum_ratio_n_elements_F": int(n_F),
            "d_jet_O": float(djo),
            "d_jet_F": float(djf),
        }
        if np.isfinite(v_O_bulk):
            mom_update["v_O_bulk"] = float(v_O_bulk)
        if np.isfinite(v_F_bulk):
            mom_update["v_F_bulk"] = float(v_F_bulk)
        if rho_O > 0:
            mom_update["rho_O_momentum"] = float(rho_O)
        if rho_F > 0:
            mom_update["rho_F_momentum"] = float(rho_F)
        if np.isfinite(momentum_ratio_R) and momentum_ratio_R > 0:
            mom_update["momentum_ratio_R"] = momentum_ratio_R

        diagnostics.update(
            {
                # Required by chamber_solver / combustion efficiency (parity with pintle)
                "u_O": float(u_O_final),
                "u_F": float(u_F_final),
                "V_rel": u_sheet_final,
                **turb_final,
                "P_injector_O": float(P_inj_O_final),
                "P_injector_F": float(P_inj_F_final),
                "delta_p_injector_O": float(delta_p_inj_O_final),
                "delta_p_injector_F": float(delta_p_inj_F_final),
                "delta_p_feed_O": float(delta_p_feed_O_final),
                "delta_p_feed_F": float(delta_p_feed_F_final),
                "feed_orifice_coupling_iterations": int(feed_orifice_fp_last),
                "mdot_from_bernoulli_O": float(mdot_from_bernoulli_O),
                "mdot_from_bernoulli_F": float(mdot_from_bernoulli_F),
                **mom_update,
            }
        )

        # Geometric vs effective flow areas (A_eff = Cd × A_geom); reuse converged Cd_O/Cd_F
        A_eff_O, A_eff_F, eff_warns = effective_flow_areas_from_cd(diagnostics, A_O, A_F)
        diagnostics["A_geom_O"] = float(A_O)
        diagnostics["A_geom_F"] = float(A_F)
        diagnostics["A_eff_O"] = float(A_eff_O)
        diagnostics["A_eff_F"] = float(A_eff_F)
        if eff_warns:
            merge_effective_area_warnings(diagnostics, eff_warns)

        return mdot_O, mdot_F, diagnostics
