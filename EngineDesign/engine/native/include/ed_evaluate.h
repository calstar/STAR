/* ed_evaluate.h - Module 2: full evaluate (chamber solve -> nozzle -> Isp/thrust).
 *
 * Port target: runner._evaluate_internal() + nozzle.py. Flat result, no dicts.
 * STATUS: API frozen; implementation gated on the chamber/nozzle ports (README
 * "Staged plan"). Returns ED_ERR_NOT_IMPLEMENTED until then.
 */
#ifndef ED_EVALUATE_H
#define ED_EVALUATE_H

#include "ed_types.h"
#include "ed_state.h"
#include "ed_cea.h"
#include "ed_workspace.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Mirrors the runner.evaluate() keys consumed by Layer 1. */
typedef struct EdEvaluateResult {
    /* Chamber / flow */
    double Pc, mdot_O, mdot_F, mdot_total, MR;
    /* Performance */
    double F;          /* thrust, N */
    double Isp;        /* s */
    double v_exit;     /* m/s */
    double P_exit;     /* Pa */
    double P_throat;   /* Pa */
    double T_exit;     /* K */
    double T_throat;   /* K */
    /* Thermo */
    double Tc, gamma, R;
    double cstar_actual, cstar_ideal, eta_cstar;
    double Cf_actual, Cf_ideal;
    double eps, A_throat, A_exit;
    double Cd_O, Cd_F;
    /* Injector diagnostics for Layer-1 penalties */
    double momentum_ratio_R;
    double delta_P_injector_O, delta_P_injector_F;
    double A_geom_O, A_geom_F;
    double SMD;
    /* Cooling summary (only what objective/stability need) */
    double cooling_efficiency;
    double Tc_effective;
    int    converged;
} EdEvaluateResult;

ed_status_t ed_evaluate(const EdEngineState *state,
                        const EdCeaTables *cea,
                        double P_tank_O_Pa,
                        double P_tank_F_Pa,
                        double P_ambient_Pa,
                        double Pc_guess_Pa,
                        EdWorkspace *ws,
                        EdEvaluateResult *out);

/* Stretch batch API: one state + workspace, many tank-pressure pairs. */
ed_status_t ed_evaluate_batch(const EdEngineState *state,
                              const EdCeaTables *cea,
                              size_t n,
                              const double *P_tank_O_Pa,
                              const double *P_tank_F_Pa,
                              double P_ambient_Pa,
                              EdWorkspace *ws,
                              EdEvaluateResult *out);

#ifdef __cplusplus
}
#endif

#endif /* ED_EVALUATE_H */
