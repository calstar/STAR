/* ed_injector_impinging.c - Port of ImpingingInjector.solve (impinging.py).
 *
 * Structure mirrors Python exactly:
 *   outer spray-constraint loop (closure.max_iterations), each pass runs a
 *   feed-loss <-> inlet-pressure <-> Bernoulli fixed point (under-relaxed, 0.35),
 *   whose inner Cd<->Bernoulli sub-iteration solves mdot = Cd(Re(mdot)) A sqrt(2 rho dP).
 * Converged mdot is a fixed point, so matching the same tolerances reproduces the
 * Python result to ~1e-9 (well within the 1e-3 parity target).
 *
 * Regen-coupled feed loss (config.regen_cooling.enabled) adds delta_p_regen_channels,
 * not yet ported -> returns ED_ERR_NOT_IMPLEMENTED so callers fall back to Python.
 */
#include "ed_injector.h"
#include "ed_spray.h"
#include "ed_feed_loss.h"
#include "ed_discharge.h"
#include <string.h>

#define FP_TOL        1e-6
#define FP_MAX_ITER   150
#define CD_INNER_MAX  120
#define CD_INNER_TOL  1e-12
#define FP_RELAX      0.35

/* Inner: for a fixed inlet head dP_inj, iterate mdot = Cd(Re(mdot)) A sqrt(2 rho dP). */
static double bern_mdot_with_cd(double mdot_seed, double dP_inj, double Pi_inj,
                                double rho, double area, double d_hyd, double mu,
                                const EdDischarge *disc, double Tin, double cd_cap,
                                double *cd_out) {
    if (dP_inj <= 0.0) {
        double cd0 = ed_min(ed_cd_from_re(0.0, disc, Pi_inj, Tin, d_hyd), cd_cap);
        *cd_out = cd0;
        return 0.0;
    }
    double cd_lo = ed_min(ed_cd_from_re(0.0, disc, Pi_inj, Tin, d_hyd), cd_cap);
    double m = (mdot_seed > 1e-18) ? mdot_seed : cd_lo * area * sqrt(2.0 * rho * dP_inj);
    double cd = cd_lo;

    for (int cin = 1; cin <= CD_INNER_MAX; ++cin) {
        double m_was = m;
        double u_loc = (area > 0.0) ? m / (rho * area) : 0.0;
        double Re_loc = ed_reynolds(rho, u_loc, d_hyd, mu);
        cd = ed_min(ed_cd_from_re(Re_loc, disc, Pi_inj, Tin, d_hyd), cd_cap);
        m = cd * area * sqrt(2.0 * rho * dP_inj);
        double inn_rel = fabs(m - m_was) / ed_max(fabs(m_was), 1e-18);
        if (inn_rel < CD_INNER_TOL) break;
    }
    *cd_out = cd;
    return m;
}

ed_status_t ed_injector_impinging_solve(const EdEngineState *st,
                                        double P_tank_O, double P_tank_F, double Pc,
                                        EdInjectorResult *out) {
    if (!st || !out) return ED_ERR_INVALID_ARG;
    if (st->cooling.regen_enabled) return ED_ERR_NOT_IMPLEMENTED;

    memset(out, 0, sizeof(*out));
    const EdInjector *inj = &st->injector;
    const EdDischarge *dO = &st->discharge_O, *dF = &st->discharge_F;
    const EdFeed *fO = &st->feed_O, *fF = &st->feed_F;
    const EdSpray *sp = &st->spray;

    const double rho_O = st->fluid_O.density, mu_O = st->fluid_O.viscosity, sig_O = st->fluid_O.surface_tension;
    const double rho_F = st->fluid_F.density, mu_F = st->fluid_F.viscosity, sig_F = st->fluid_F.surface_tension;
    const double T_O = st->fluid_O.temperature, T_F = st->fluid_F.temperature;

    const double djo = inj->imp_O.d_jet, djf = inj->imp_F.d_jet;
    const int    nO = inj->imp_O.n_elements, nF = inj->imp_F.n_elements;
    const double A_O = nO * ED_PI * (djo * 0.5) * (djo * 0.5);
    const double A_F = nF * ED_PI * (djf * 0.5) * (djf * 0.5);

    const int    max_iter = st->solver.closure_max_iterations;
    const double Cd_reduction = st->solver.closure_Cd_reduction_factor;
    double Cd_O_eff = ed_cd_inf_from_orifice_diameter(djo, dO);
    double Cd_F_eff = ed_cd_inf_from_orifice_diameter(djf, dF);

    double imp_sep = ed_clip((double)inj->imp_O.impingement_angle + inj->imp_F.impingement_angle, 1.0, 179.0);
    double imp_angle = imp_sep * ED_PI / 180.0;

    double mdot_O = 0.1, mdot_F = 0.1;
    double Cd_O = 0.0, Cd_F = 0.0;
    double Pi_O = P_tank_O, Pi_F = P_tank_F;
    double dpf_O = 0.0, dpf_F = 0.0, dpi_O = 0.0, dpi_F = 0.0;
    int fp_last = 0;
    double We_O = 0, We_F = 0, D32_O = 0, D32_F = 0, J = 0, TMR = 0, theta = 0, x_star = 0, u_rel = 0;
    double ti_mix = 0.0;
    int constraints_ok = 0, iters_done = 0;

    for (int iteration = 0; iteration < max_iter; ++iteration) {
        iters_done = iteration + 1;
        /* ---- feed-orifice fixed point ---- */
        double mo = mdot_O, mf = mdot_F;
        Pi_O = P_tank_O; Pi_F = P_tank_F;
        dpi_O = dpi_F = dpf_O = dpf_F = 0.0;
        Cd_O = Cd_F = 0.0;
        int fp_it = 0;

        for (fp_it = 1; fp_it <= FP_MAX_ITER; ++fp_it) {
            double mo_prev = mo, mf_prev = mf;

            dpf_O = ed_delta_p_feed(mo, rho_O, fO, P_tank_O);
            dpf_F = ed_delta_p_feed(mf, rho_F, fF, P_tank_F);
            Pi_O = P_tank_O - dpf_O; Pi_F = P_tank_F - dpf_F;
            dpi_O = ed_max(0.0, Pi_O - Pc); dpi_F = ed_max(0.0, Pi_F - Pc);

            double mo_new, mf_new, cdo, cdf;
            if (Pi_O < Pc) { mo_new = 0.0; cdo = ed_min(ed_cd_from_re(0.0, dO, Pi_O, T_O, djo), Cd_O_eff); }
            else mo_new = bern_mdot_with_cd(mo, dpi_O, Pi_O, rho_O, A_O, djo, mu_O, dO, T_O, Cd_O_eff, &cdo);
            if (Pi_F < Pc) { mf_new = 0.0; cdf = ed_min(ed_cd_from_re(0.0, dF, Pi_F, T_F, djf), Cd_F_eff); }
            else mf_new = bern_mdot_with_cd(mf, dpi_F, Pi_F, rho_F, A_F, djf, mu_F, dF, T_F, Cd_F_eff, &cdf);

            double w = FP_RELAX;
            mo = mo_prev + w * (mo_new - mo_prev);
            mf = mf_prev + w * (mf_new - mf_prev);

            /* recompute consistent heads at the relaxed iterate */
            dpf_O = ed_delta_p_feed(mo, rho_O, fO, P_tank_O);
            dpf_F = ed_delta_p_feed(mf, rho_F, fF, P_tank_F);
            Pi_O = P_tank_O - dpf_O; Pi_F = P_tank_F - dpf_F;
            dpi_O = ed_max(0.0, Pi_O - Pc); dpi_F = ed_max(0.0, Pi_F - Pc);

            if (Pi_O < Pc) {
                Cd_O = ed_min(ed_cd_from_re(0.0, dO, Pi_O, T_O, djo), Cd_O_eff);
            } else {
                double u_o2 = (A_O > 0.0) ? mo / (rho_O * A_O) : 0.0;
                double Re_o2 = ed_reynolds(rho_O, u_o2, djo, mu_O);
                Cd_O = ed_min(ed_cd_from_re(Re_o2, dO, Pi_O, T_O, djo), Cd_O_eff);
            }
            if (Pi_F < Pc) {
                Cd_F = ed_min(ed_cd_from_re(0.0, dF, Pi_F, T_F, djf), Cd_F_eff);
            } else {
                double u_f2 = (A_F > 0.0) ? mf / (rho_F * A_F) : 0.0;
                double Re_f2 = ed_reynolds(rho_F, u_f2, djf, mu_F);
                Cd_F = ed_min(ed_cd_from_re(Re_f2, dF, Pi_F, T_F, djf), Cd_F_eff);
            }

            double den_o = ed_max(ed_max(fabs(mo_prev), fabs(mo)), 1e-18);
            double den_f = ed_max(ed_max(fabs(mf_prev), fabs(mf)), 1e-18);
            double rel_o = fabs(mo - mo_prev) / den_o;
            double rel_f = fabs(mf - mf_prev) / den_f;
            if (rel_o < FP_TOL && rel_f < FP_TOL) break;
        }
        fp_last = fp_it > FP_MAX_ITER ? FP_MAX_ITER : fp_it;
        mdot_O = mo; mdot_F = mf;

        /* ---- spray diagnostics ---- */
        double u_O = (A_O > 0.0) ? mdot_O / (rho_O * A_O) : 0.0;
        double u_F = (A_F > 0.0) ? mdot_F / (rho_F * A_F) : 0.0;
        u_rel = sqrt(u_O * u_O + u_F * u_F - 2.0 * u_O * u_F * cos(imp_angle));

        /* turbulence mix intensity (for downstream models) */
        {
            double Re_Ol = ed_reynolds(rho_O, u_O, djo, mu_O);
            double Re_Fl = ed_reynolds(rho_F, u_F, djf, mu_F);
            double ti_O = (Re_Ol > 0.0) ? 0.16 * pow(Re_Ol, -0.125) : 0.1;
            double ti_F = (Re_Fl > 0.0) ? 0.16 * pow(Re_Fl, -0.125) : 0.1;
            ti_O = ed_clip(ti_O, 0.02, 0.3); ti_F = ed_clip(ti_F, 0.02, 0.3);
            double vtot = ed_max(u_O + u_F, 1e-6);
            ti_mix = ed_clip((ti_O * u_O + ti_F * u_F) / vtot, 0.02, 0.35);
        }

        double rho_gas = ed_max(Pc / (sp->chamber_gas_R * sp->chamber_gas_T), 1e-6);
        J = ed_momentum_flux_ratio(rho_O, u_O, rho_F, u_F);
        double MR = (mdot_F > 0.0) ? mdot_O / mdot_F : INFINITY;
        TMR = ed_thrust_momentum_ratio(J, MR);
        theta = (sp->spray_angle_model == ED_SPRAYANG_J)
                  ? ed_spray_angle_from_J(J, sp->spray_angle_k, sp->spray_angle_n)
                  : ed_spray_angle_from_TMR(TMR);

        double Oh_O = ed_ohnesorge_number(mu_O, rho_O, sig_O, djo);
        double Oh_F = ed_ohnesorge_number(mu_F, rho_F, sig_F, djf);

        if (sp->smd_model == ED_SMD_INGEBO) {
            We_O = ed_weber_number(rho_gas, u_rel, djo, sig_O);
            We_F = ed_weber_number(rho_gas, u_rel, djf, sig_F);
            D32_O = ed_smd_impinging_ingebo(djo, u_rel, rho_O, mu_O, sig_O, rho_gas, sp->smd_C_ingebo);
            D32_F = ed_smd_impinging_ingebo(djf, u_rel, rho_F, mu_F, sig_F, rho_gas, sp->smd_C_ingebo);
        } else {
            double alpha = 0.35;
            double ue_O = sqrt(ed_max(u_O, 0.0) * ed_max(u_O, 0.0) + (alpha * ed_max(u_rel, 0.0)) * (alpha * ed_max(u_rel, 0.0)));
            double ue_F = sqrt(ed_max(u_F, 0.0) * ed_max(u_F, 0.0) + (alpha * ed_max(u_rel, 0.0)) * (alpha * ed_max(u_rel, 0.0)));
            We_O = ed_weber_number(rho_O, ue_O, djo, sig_O);
            We_F = ed_weber_number(rho_F, ue_F, djf, sig_F);
            double weO = We_O, weF = We_F;
            if (sp->smd_we_corr_max > 0.0 && isfinite(sp->smd_we_corr_max)) {
                weO = ed_min(We_O, sp->smd_we_corr_max);
                weF = ed_min(We_F, sp->smd_we_corr_max);
            }
            D32_O = ed_smd_lefebvre(djo, weO, Oh_O, sp->smd_C, sp->smd_m, sp->smd_p);
            D32_F = ed_smd_lefebvre(djf, weF, Oh_F, sp->smd_C, sp->smd_m, sp->smd_p);
        }

        double te_O = ed_tau_evap(D32_O, sp->evap_K);
        double te_F = ed_tau_evap(D32_F, sp->evap_K);
        x_star = ed_max(ed_xstar(u_rel, te_O), ed_xstar(u_rel, te_F));

        constraints_ok = ed_check_spray_constraints(We_O, We_F, x_star, sp);
        out->u_O = u_O; out->u_F = u_F;
        if (constraints_ok) break;

        Cd_O_eff *= Cd_reduction; Cd_F_eff *= Cd_reduction;
        Cd_O_eff = ed_max(Cd_O_eff, dO->Cd_min);
        Cd_F_eff = ed_max(Cd_F_eff, dF->Cd_min);
    }

    /* ---- final momentum-balance metric (bulk velocities through jets) ---- */
    double A_jet_O = ED_PI * (djo * 0.5) * (djo * 0.5);
    double A_jet_F = ED_PI * (djf * 0.5) * (djf * 0.5);
    int n_O = nO < 1 ? 1 : nO, n_F = nF < 1 ? 1 : nF;
    double denom_O = rho_O * (double)n_O * A_jet_O;
    double denom_F = rho_F * (double)n_F * A_jet_F;
    double v_O_bulk = (denom_O > 0.0) ? mdot_O / denom_O : NAN;
    double v_F_bulk = (denom_F > 0.0) ? mdot_F / denom_F : NAN;
    double mom_R = NAN;
    if (rho_O > 0.0 && rho_F > 0.0 && isfinite(v_O_bulk) && isfinite(v_F_bulk) && v_F_bulk != 0.0) {
        double num = rho_O * v_O_bulk * v_O_bulk, den = rho_F * v_F_bulk * v_F_bulk;
        if (den > 0.0 && num >= 0.0) mom_R = sqrt(num / den);
    }

    out->mdot_O = mdot_O; out->mdot_F = mdot_F;
    out->Cd_O = Cd_O; out->Cd_F = Cd_F;
    out->A_geom_O = A_O; out->A_geom_F = A_F;
    out->A_eff_O = Cd_O * A_O; out->A_eff_F = Cd_F * A_F;
    out->v_O_bulk = v_O_bulk; out->v_F_bulk = v_F_bulk;
    out->momentum_ratio_R = mom_R;
    out->J = J; out->TMR = TMR; out->theta = theta;
    out->We_O = We_O; out->We_F = We_F;
    out->D32_O = D32_O; out->D32_F = D32_F;
    out->x_star = x_star; out->u_rel = u_rel;
    out->P_injector_O = Pi_O; out->P_injector_F = Pi_F;
    out->delta_p_injector_O = dpi_O; out->delta_p_injector_F = dpi_F;
    out->delta_p_feed_O = dpf_O; out->delta_p_feed_F = dpf_F;
    out->turbulence_intensity_mix = ti_mix;
    out->MR = (mdot_F > 0.0) ? mdot_O / mdot_F : 0.0;
    out->constraints_satisfied = constraints_ok;
    out->iterations = iters_done;
    out->feed_orifice_coupling_iters = fp_last;
    return ED_OK;
}

ed_status_t ed_injector_solve(const EdEngineState *st,
                              double P_tank_O, double P_tank_F, double Pc,
                              EdInjectorResult *out) {
    if (!st || !out) return ED_ERR_INVALID_ARG;
    switch (st->injector.type) {
        case ED_INJ_IMPINGING:
            return ed_injector_impinging_solve(st, P_tank_O, P_tank_F, Pc, out);
        default:
            memset(out, 0, sizeof(*out));
            return ED_ERR_NOT_IMPLEMENTED; /* pintle/coaxial: later stage */
    }
}
