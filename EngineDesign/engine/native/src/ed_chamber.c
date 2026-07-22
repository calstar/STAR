/* ed_chamber.c - Module 1: chamber-pressure solve.
 *
 * Faithful port of ChamberSolver.residual()/solve() (engine/core/chamber_solver.py).
 * The residual composes the native injector solve (closure.flows), CEA eval,
 * eta_cstar (combustion_physics), and the ablative cooling_eff, then balances
 * supply (injector) against demand (Pc*At/cstar_actual). Brent replaces brentq.
 * Allocation-free in the residual loop.
 */
#include "ed_chamber.h"
#include "ed_injector.h"
#include "ed_combustion.h"
#include "ed_cooling.h"
#include "ed_root_find.h"

#include <math.h>
#include <string.h>

typedef struct {
    const EdEngineState *st;
    const EdCeaTables *cea;
    double P_O, P_F;
    /* last-evaluated diagnostics (filled on the final residual call) */
    EdChamberDiagnostics *diag;
    int fill;
} ed_chamber_ctx;

static double infer_Lstar(const EdGeometry *g) {
    if (g->Lstar > 0) return g->Lstar;
    if (g->A_throat > 0) return g->volume / g->A_throat;
    return 0.0;
}

/* residual = mdot_supply - mdot_demand; NaN on any invalid sub-result (mirrors
 * the Python residual returning np.nan, which the solver treats as out-of-domain). */
static double chamber_residual(double Pc, void *vctx) {
    ed_chamber_ctx *c = (ed_chamber_ctx *)vctx;
    const EdEngineState *st = c->st;
    const EdGeometry *g = &st->geom;

    if (!(isfinite(Pc) && Pc > 0)) return NAN;

    EdInjectorResult inj;
    if (ed_injector_solve(st, c->P_O, c->P_F, Pc, &inj) != ED_OK) return NAN;
    const double mdot_O = inj.mdot_O, mdot_F = inj.mdot_F;
    if (!(isfinite(mdot_O) && isfinite(mdot_F)) || mdot_F <= 0.0) return NAN;
    const double mdot_supply = mdot_O + mdot_F;
    const double MR = mdot_O / mdot_F;

    EdCeaResult cea;
    if (ed_cea_eval(c->cea, MR, Pc, ED_P_SEA_LEVEL, g->expansion_ratio, &cea) != ED_OK) return NAN;
    if (!(cea.cstar_ideal > 0 && isfinite(cea.cstar_ideal))) return NAN;

    const double Lstar = infer_Lstar(g);
    const double Dinj = st->injector.imp_O.d_jet; /* _infer_injector_diameter (impinging) */
    const double Ac = ED_PI * (g->chamber_diameter * 0.5) * (g->chamber_diameter * 0.5);

    /* Rupe mixing optimum: honor an explicit R_opt override, else derive from the
     * impinging-doublet angles (sqrt(sin(theta_F)/sin(theta_O))), 1.0 otherwise. */
    double R_opt;
    if (st->comb.R_opt > 0.0) {
        R_opt = st->comb.R_opt;
    } else {
        const double sO = sin(st->injector.imp_O.impingement_angle * ED_PI / 180.0);
        const double sF = sin(st->injector.imp_F.impingement_angle * ED_PI / 180.0);
        R_opt = (sO > 0.0 && sF > 0.0) ? sqrt(sF / sO) : 1.0;
    }

    EdEtaResult eta;
    if (ed_combustion_efficiency_advanced(
            &st->comb, Lstar, Pc, cea.Tc, cea.cstar_ideal, cea.gamma, cea.R, MR,
            Ac, g->A_throat, Dinj, mdot_supply, inj.u_F, inj.u_O,
            inj.D32_O, inj.D32_F, inj.momentum_ratio_R, R_opt,
            st->fluid_F.latent_heat, st->comb.T_star_fuel_cap_K, &eta) != ED_OK)
        return NAN;

    /* ORDER MATTERS: combustion efficiency FIRST, then cooling -- mirrors
     * chamber_solver.residual(). The cooling models need a gas temperature, and
     * a real chamber runs cooler than CEA's ideal value because combustion is
     * incomplete, so Tc is knocked down by eta_combustion^2 (Huzel & Huang
     * Sample Calc 4-3: c* ~ sqrt(Tc), so a c*-measured efficiency lands on
     * temperature squared) before the heat transfer is evaluated. Running
     * cooling first computed the heat load several hundred K too hot.
     *
     * Not circular: ed_combustion_efficiency_advanced takes no cooling input. */
    const double Tc_combustion = cea.Tc * eta.eta_total * eta.eta_total;

    EdCoolingResult cool;
    if (ed_cooling_evaluate(st, Pc, mdot_O, mdot_F, Tc_combustion, cea.gamma, cea.R, cea.M,
                            &cool) != ED_OK)
        return NAN;

    /* eta.eta_total is combustion-only (mixing x kinetics x L*) despite the
     * name; eta_final is the c* efficiency. Mirrors combustion_eff.eta_cstar --
     * see that module's docstring before applying either to a temperature.
     *
     * cooling_eff is an ENERGY fraction and c* goes as sqrt(Tc), so the
     * conversion into a c* factor is a square root. Multiplying by cooling_eff
     * directly (as this did) roughly doubles cooling's penalty on c*. */
    const double eta_final = eta.eta_total * sqrt(cool.cooling_eff);
    if (!(isfinite(eta_final) && eta_final > 0.0 && eta_final <= 1.0)) return NAN;

    const double cstar_actual = eta_final * cea.cstar_ideal;
    const double mdot_demand = Pc * g->A_throat / cstar_actual;
    const double residual = mdot_supply - mdot_demand;
    if (!isfinite(residual)) return NAN;

    if (c->fill && c->diag) {
        EdChamberDiagnostics *d = c->diag;
        d->Pc = Pc; d->mdot_O = mdot_O; d->mdot_F = mdot_F; d->mdot_total = mdot_supply;
        d->MR = MR; d->cstar_ideal = cea.cstar_ideal; d->cstar_actual = cstar_actual;
        d->eta_cstar = eta_final; d->cooling_efficiency = cool.cooling_eff;
        d->Tc = cool.effective_Tc; d->Tc_ideal = cea.Tc; d->gamma = cea.gamma; d->R = cea.R; d->M = cea.M;
        d->momentum_ratio_R = inj.momentum_ratio_R;
        d->delta_P_injector_O = inj.delta_p_injector_O;
        d->delta_P_injector_F = inj.delta_p_injector_F;
        d->A_geom_O = inj.A_geom_O; d->A_geom_F = inj.A_geom_F;
        d->SMD = ed_max(inj.D32_O, inj.D32_F);
        d->Cd_O = inj.Cd_O; d->Cd_F = inj.Cd_F; d->u_O = inj.u_O; d->u_F = inj.u_F;
    }
    return residual;
}

ed_status_t ed_chamber_solve(const EdEngineState *state,
                             const EdCeaTables *cea,
                             double P_tank_O_Pa,
                             double P_tank_F_Pa,
                             double Pc_guess_Pa,
                             EdWorkspace *ws,
                             EdChamberDiagnostics *out) {
    (void)Pc_guess_Pa; (void)ws;
    if (!state || !cea || !out) return ED_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));

    /* Bounds: ChamberSolver.solve(). 15% feed-loss margin below min tank pressure. */
    double Pc_min = 100000.0;
    double Pc_max = ed_min(P_tank_O_Pa, P_tank_F_Pa) * (1.0 - 0.15);
    Pc_min = ed_max(Pc_min, state->solver.Pc_min_bound);
    Pc_max = ed_min(Pc_max, state->solver.Pc_max_bound);
    if (Pc_max <= Pc_min) return ED_ERR_NO_BRACKET;

    ed_chamber_ctx ctx = { state, cea, P_tank_O_Pa, P_tank_F_Pa, NULL, 0 };

    const double r_min = chamber_residual(Pc_min, &ctx);
    const double r_max = chamber_residual(Pc_max, &ctx);
    if (!isfinite(r_min) || !isfinite(r_max)) return ED_ERR_NONFINITE;

    double Pc;
    int iters = 0;
    if (ed_sign(r_min) == ed_sign(r_max)) {
        /* Python: supply>demand everywhere but within 0.1 kg/s of balance -> accept Pc_max. */
        if (r_min > 0 && r_max > 0 && r_max < 0.1) {
            Pc = Pc_max;
        } else {
            return ED_ERR_NO_BRACKET; /* infeasible point; Python raises -> caller falls back */
        }
    } else {
        ed_root_opts opt = {
            .xtol = state->solver.tolerance,
            .rtol = state->solver.tolerance * 1e-3,
            .max_iter = state->solver.max_iterations > 0 ? state->solver.max_iterations : 100,
        };
        ed_root_result rr;
        ed_status_t rc = ed_brentq(chamber_residual, &ctx, Pc_min, Pc_max, &opt, &rr);
        if (rc != ED_OK) return rc;
        Pc = rr.root;
        iters = rr.iterations;
    }

    /* Final pass to populate diagnostics at the solved Pc. */
    ctx.diag = out; ctx.fill = 1;
    const double rfinal = chamber_residual(Pc, &ctx);
    if (!isfinite(rfinal)) return ED_ERR_NONFINITE;
    out->converged = 1;
    out->residual_iters = iters;
    return ED_OK;
}
