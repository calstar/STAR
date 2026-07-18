/* ed_combustion_physics.c - faithful port of engine/pipeline/combustion_physics.py
 * (the eta_c* advanced model: L*, kinetics, mixing, turbulence).
 *
 * Parity is to machine precision: every expression, default, and clamp matches the
 * Python source. Diagnostics-only branches (Spalding, debug logging, warnings) are
 * omitted since they do not affect the returned values.
 */
#include "ed_combustion.h"
#include "ed_phys_const.h"

#include <math.h>

/* compute_combustion_state: shared geometric/velocity state. */
typedef struct {
    double rho_ch, U_bulk, G_throat, tau_res, L_mix, U_rms, dU, U_mix;
    int ok;
} ed_comb_state;

static ed_comb_state combustion_state(double Pc, double Tc, double R, double Ac,
                                      double At, double Lstar, double m_dot_total,
                                      double Dinj, double u_fuel, double u_lox) {
    ed_comb_state s; s.ok = 0;
    if (R <= 0 || Tc <= 0 || Ac <= 0 || At <= 0 || Dinj <= 0 || Lstar <= 0 || m_dot_total <= 0)
        return s;
    s.rho_ch = Pc / (R * Tc);
    s.U_bulk = m_dot_total / (s.rho_ch * Ac);
    s.G_throat = m_dot_total / At;
    s.tau_res = (Lstar * s.rho_ch) / s.G_throat;
    s.L_mix = ED_CS_C_L * Dinj;
    const double uf = u_fuel, uo = u_lox;
    s.U_rms = sqrt(0.5 * (uf * uf + uo * uo));
    if (!isfinite(s.U_rms) || s.U_rms < 0 || s.U_rms > ED_CS_U_RMS_CAP) return s;
    s.dU = fabs(uf - uo);
    s.U_mix = sqrt(s.dU * s.dU + ED_CS_C_U * s.U_rms * s.U_rms);
    if (!isfinite(s.U_mix) || s.U_mix <= 0) return s;
    s.ok = 1;
    return s;
}

/* calculate_gasification_efficiency -> eta_vap. */
static double gasification_eta(double Tc, double Pc, double tau_res, double SMD,
                               double L_eff, double cp_g, double rho_g,
                               double U_slip, double T_star_cap) {
    const double rho_l = ED_GAS_RHO_L_DEFAULT, cp_l = ED_GAS_CP_L_DEFAULT;
    const double T_inj = ED_GAS_T_INJ_DEFAULT, mu_g = ED_GAS_MU_DEFAULT, Pr = ED_PRANDTL_DEFAULT;

    const double D = ed_max(SMD, ED_D_MIN_GASIFICATION);
    const double D_sq = D * D;

    const double dT_safe = ed_max(200.0, 0.10 * Tc);
    const double T_star_upper = ed_min(T_star_cap, Tc - dT_safe);
    const double T_star_lower = T_inj + 50.0;
    const double T_star = ed_clip(T_star_upper, T_star_lower, Tc - dT_safe);

    const double k_g = mu_g * cp_g / Pr;
    const double D_m = ED_D_M_REF * pow(Tc / ED_D_M_T_REF, 1.75) * (ED_D_M_P_REF / ed_max(Pc, 1e3));

    double U_slip_capped = ed_min(fabs(U_slip), ED_U_SLIP_CAP);
    U_slip_capped = ed_max(U_slip_capped, 0.1);

    const double Re = rho_g * U_slip_capped * D / ed_max(mu_g, 1e-10);
    const double Sc = mu_g / (rho_g * ed_max(D_m, 1e-12));
    const double Nu = 2.0 + 0.6 * sqrt(ed_max(Re, 0.0)) * pow(Pr, 1.0 / 3.0);
    const double Sh = 2.0 + 0.6 * sqrt(ed_max(Re, 0.0)) * pow(Sc, 1.0 / 3.0);

    const double dT_initial = Tc - T_inj;
    const double dT_final = Tc - T_star;
    double tau_heat;
    if (dT_final <= 0 || dT_initial <= dT_final) {
        tau_heat = 1e-9;
    } else {
        tau_heat = (rho_l * cp_l * D_sq) / (6.0 * Nu * k_g) * log(dT_initial / dT_final);
    }

    const double energy_available = cp_g * (Tc - T_star);
    const double energy_required = energy_available + L_eff;
    const double Phi = ed_clip(energy_available / ed_max(energy_required, 1e-6), 1e-6, 1.0);

    const double denom = 6.0 * rho_g * D_m * Sh * Phi;
    const double tau_gasify = (denom <= 0) ? INFINITY : (rho_l * D_sq) / denom;

    const double tau_heat_safe = ed_max(tau_heat, 1e-12);
    const double tau_gasify_safe = ed_max(tau_gasify, 1e-12);
    const double tau_vap = 1.0 / (1.0 / tau_heat_safe + 1.0 / tau_gasify_safe);

    if (tau_vap <= 0 || !isfinite(tau_vap)) return 1.0;
    return 1.0 - exp(-tau_res / tau_vap);
}

/* calculate_reaction_time_scale */
static double reaction_time_scale(double Pc, double Tc, double MR,
                                  const EdCombustionEff *cfg) {
    double Ea_norm = (MR < 1.5) ? 12.0 : (MR > 3.0 ? 8.0 : 10.0);
    const double pressure_factor = pow(cfg->tau_ref_P / ed_max(Pc, 1e5), cfg->n_pressure);
    double Tc_eff = Tc;
    if (cfg->has_tau_Tc_floor && isfinite(cfg->tau_Tc_floor) && cfg->tau_Tc_floor > 0)
        Tc_eff = ed_max(Tc_eff, cfg->tau_Tc_floor);
    double exp_arg = Ea_norm * (cfg->tau_ref_T / ed_max(Tc_eff, 1000.0) - 1.0);
    exp_arg = ed_clip(exp_arg, -20.0, 20.0);
    return cfg->tau_ref * pressure_factor * exp(exp_arg);
}

/* calculate_rupe_mixing_efficiency: eta_mix = Em_peak * exp(-(ln(R/R_opt))^2/(2 sigma^2)).
 * Momentum-ratio mixing efficiency (Rupe/SP-8089); replaces the k-e near-field model
 * and the retired eta_turbulence step. Returns <0 to signal an invalid momentum ratio.
 *
 * INTENTIONAL C-vs-Python divergence on invalid R: Python falls back to
 * eta_mix = Em_peak (its lenient branch exists for pintle/coaxial, which have no
 * impinging momentum ratio), whereas here an invalid R propagates as
 * ED_ERR_INVALID_ARG -> NaN residual -> the native solve fails and that call
 * falls back to Python. This is deliberate strictness, not a physics
 * disagreement: the C path only runs for impinging configs, whose injector solve
 * always produces a valid R — an invalid R here means something upstream is
 * broken, and refusing (worst case: a slower Python answer) beats guessing. */
static double rupe_mixing_eta(double momentum_ratio_R, double R_opt,
                              double Em_peak, double sigma) {
    if (!(momentum_ratio_R > 0.0 && isfinite(momentum_ratio_R))) return -1.0;
    const double Ro = (R_opt > 0.0 && isfinite(R_opt)) ? R_opt : 1.0;
    const double sig = (sigma > 0.0 && isfinite(sigma)) ? sigma : 1.5;
    const double z = log(momentum_ratio_R / Ro);
    return Em_peak * exp(-(z * z) / (2.0 * sig * sig));
}

/* _mass_flux_weighted_d32_um (returns metres). do/df <=0 == absent. */
static double smd_weighted(double do_m, double df_m, double MR) {
    const int o_ok = (do_m > 0 && isfinite(do_m));
    const int f_ok = (df_m > 0 && isfinite(df_m));
    if (o_ok && f_ok) {
        if (!(isfinite(MR) && MR > 0)) return 0.5 * (do_m + df_m);
        const double w_o = MR / (1.0 + MR), w_f = 1.0 / (1.0 + MR);
        return w_o * do_m + w_f * df_m;
    }
    if (o_ok) return do_m;
    if (f_ok) return df_m;
    return -1.0; /* signals "no valid SMD" -> caller errors */
}

ed_status_t ed_combustion_efficiency_advanced(
    const EdCombustionEff *cfg,
    double Lstar, double Pc, double Tc, double cstar_ideal,
    double gamma, double R, double MR,
    double Ac, double At, double Dinj, double m_dot_total,
    double u_fuel, double u_lox,
    double D32_O, double D32_F,
    double momentum_ratio_R, double R_opt,
    double fuel_latent_heat,
    double fuel_T_star_cap_K,
    EdEtaResult *out) {
    (void)cstar_ideal;
    if (!cfg || !out) return ED_ERR_INVALID_ARG;

    const ed_comb_state st = combustion_state(Pc, Tc, R, Ac, At, Lstar, m_dot_total,
                                              Dinj, u_fuel, u_lox);
    if (!st.ok) return ED_ERR_NONFINITE;

    const double cp_g = (gamma > 1.0) ? gamma * R / (gamma - 1.0) : ED_GAS_CP_G_DEFAULT;

    /* 1. eta_Lstar */
    double eta_Lstar;
    if (cfg->model == ED_EFF_CONSTANT) {
        eta_Lstar = 1.0 - cfg->C;
    } else if (cfg->model == ED_EFF_LINEAR) {
        eta_Lstar = ed_clip(1.0 - cfg->C * (1.0 - Lstar / 1.0), 0.0, 1.0);
    } else { /* exponential */
        const double SMD = smd_weighted(D32_O, D32_F, MR);
        if (SMD <= 0) return ED_ERR_INVALID_ARG;
        const double U_slip = ed_max(st.U_bulk, st.U_mix);
        eta_Lstar = gasification_eta(Tc, Pc, st.tau_res, SMD, fuel_latent_heat,
                                     cp_g, st.rho_ch, U_slip, fuel_T_star_cap_K);
    }

    /* 2. eta_kinetics (Da from geometric tau_res and chemical tau_chem) */
    const double tau_chem = reaction_time_scale(Pc, Tc, MR, cfg);
    const double Da = (tau_chem <= 0) ? INFINITY : st.tau_res / tau_chem;
    const double eta_kinetics = 1.0 - exp(-sqrt(Da));

    /* 3. eta_mixing (Rupe momentum-ratio model; turbulence folded in, no separate term) */
    const double eta_mixing = rupe_mixing_eta(momentum_ratio_R, R_opt,
                                              cfg->Em_peak, cfg->mixing_sigma);
    if (eta_mixing < 0.0) return ED_ERR_INVALID_ARG;

    out->eta_Lstar = eta_Lstar;
    out->eta_kinetics = eta_kinetics;
    out->eta_mixing = eta_mixing;
    out->eta_total = eta_Lstar * eta_kinetics * eta_mixing;
    out->Da = Da;
    out->tau_res = st.tau_res;
    out->tau_chem = tau_chem;

    if (!isfinite(out->eta_total)) return ED_ERR_NONFINITE;
    return ED_OK;
}
