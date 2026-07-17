/* ed_evaluate.c - Module 2 entry point (chamber solve -> nozzle -> Isp/thrust).
 *
 * Mirrors runner._evaluate_internal(): solve the chamber, evaluate CEA at the
 * converged (MR, Pc, eps) for the nozzle thermo, run the FROZEN nozzle, then
 * flatten everything Layer-1 reads into EdEvaluateResult. The nozzle is frozen
 * (Phase 1a); the Python shifting-equilibrium nozzle stays authoritative at
 * Layer-1 finalization (see CPORT_COMPLETION_PLAN.md). */
#include "ed_evaluate.h"
#include "ed_chamber.h"
#include "ed_nozzle.h"
#include <string.h>

ed_status_t ed_evaluate(const EdEngineState *state,
                        const EdCeaTables *cea,
                        double P_tank_O_Pa,
                        double P_tank_F_Pa,
                        double P_ambient_Pa,
                        double Pc_guess_Pa,
                        EdWorkspace *ws,
                        EdEvaluateResult *out) {
    if (!state || !out) return ED_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));

    EdChamberDiagnostics ch;
    ed_status_t rc = ed_chamber_solve(state, cea, P_tank_O_Pa, P_tank_F_Pa,
                                      Pc_guess_Pa, ws, &ch);
    if (rc != ED_OK) return rc;

    const EdGeometry *g = &state->geom;
    const double eps = g->expansion_ratio;

    /* Nozzle thermo: CEA at the converged operating point (mirrors nozzle.py:229
     * cea_cache.eval(MR, Pc, Pa, eps)). Pa is ignored by the 3D lookup, so this
     * reproduces the same grid point the chamber used. */
    EdCeaResult cr;
    rc = ed_cea_eval(cea, ch.MR, ch.Pc, P_ambient_Pa, eps, &cr);
    if (rc != ED_OK) return rc;

    EdNozzleInputs nin;
    nin.Pc = ch.Pc;
    nin.mdot_total = ch.mdot_total;
    nin.A_throat = g->A_throat;
    nin.A_exit = g->A_exit;
    nin.eps = eps;
    nin.Pa = P_ambient_Pa;
    nin.nozzle_efficiency = g->nozzle_efficiency;
    nin.Cf_ideal = cr.Cf_ideal;
    nin.gamma = cr.gamma;
    nin.R = cr.R;
    nin.Tc = cr.Tc;

    EdNozzleResult nz;
    rc = ed_nozzle_solve(&nin, &nz);
    if (rc != ED_OK) return rc;

    /* Chamber / flow */
    out->Pc = ch.Pc;
    out->mdot_O = ch.mdot_O;
    out->mdot_F = ch.mdot_F;
    out->mdot_total = ch.mdot_total;
    out->MR = ch.MR;
    /* Performance (nozzle) */
    out->F = nz.F;
    out->Isp = nz.Isp;
    out->v_exit = nz.v_exit;
    out->P_exit = nz.P_exit;
    out->P_throat = nz.P_throat;
    out->T_exit = nz.T_exit;
    out->T_throat = nz.T_throat;
    /* Thermo (ideal chamber values; nozzle expansion uses the same CEA point) */
    out->Tc = ch.Tc_ideal;
    out->gamma = ch.gamma;
    out->R = ch.R;
    out->cstar_actual = ch.cstar_actual;
    out->cstar_ideal = ch.cstar_ideal;
    out->eta_cstar = ch.eta_cstar;
    out->Cf_actual = nz.Cf_actual;
    out->Cf_ideal = nz.Cf_ideal;
    out->eps = eps;
    out->A_throat = g->A_throat;
    out->A_exit = g->A_exit;
    out->Cd_O = ch.Cd_O;
    out->Cd_F = ch.Cd_F;
    /* Injector diagnostics for Layer-1 penalties */
    out->momentum_ratio_R = ch.momentum_ratio_R;
    out->delta_P_injector_O = ch.delta_P_injector_O;
    out->delta_P_injector_F = ch.delta_P_injector_F;
    out->A_geom_O = ch.A_geom_O;
    out->A_geom_F = ch.A_geom_F;
    out->SMD = ch.SMD;
    /* Cooling summary */
    out->cooling_efficiency = ch.cooling_efficiency;
    out->Tc_effective = ch.Tc;
    out->converged = (ch.converged && nz.converged) ? 1 : 0;
    return ED_OK;
}

ed_status_t ed_evaluate_batch(const EdEngineState *state,
                              const EdCeaTables *cea,
                              size_t n,
                              const double *P_tank_O_Pa,
                              const double *P_tank_F_Pa,
                              double P_ambient_Pa,
                              EdWorkspace *ws,
                              EdEvaluateResult *out) {
    if (!P_tank_O_Pa || !P_tank_F_Pa || !out) return ED_ERR_INVALID_ARG;
    ed_status_t last = ED_OK;
    for (size_t i = 0; i < n; ++i) {
        last = ed_evaluate(state, cea, P_tank_O_Pa[i], P_tank_F_Pa[i],
                           P_ambient_Pa, 0.0, ws, &out[i]);
    }
    return last;
}
