/* ed_injector.h - Injector flow solve (closure.flows -> injector.solve).
 *
 * ed_injector_solve dispatches on state->injector.type. Stage 2 implements the
 * impinging doublet (engine/core/injectors/impinging.py); pintle/coaxial return
 * ED_ERR_NOT_IMPLEMENTED. Returns mdot_O/mdot_F plus the diagnostics the chamber
 * residual and Layer-1 penalties consume.
 */
#ifndef ED_INJECTOR_H
#define ED_INJECTOR_H

#include "ed_types.h"
#include "ed_state.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    double mdot_O, mdot_F;
    double Cd_O, Cd_F;
    double A_geom_O, A_geom_F;      /* n_elements * pi*(d_jet/2)^2 */
    double A_eff_O, A_eff_F;        /* Cd * A_geom */
    double u_O, u_F;                /* bulk velocity through jets */
    double v_O_bulk, v_F_bulk;      /* mdot/(rho*n*A_jet) */
    double momentum_ratio_R;
    double J, TMR, theta;           /* momentum flux ratio, thrust-mom ratio, spray angle */
    double We_O, We_F;
    double D32_O, D32_F;            /* SMD */
    double x_star;
    double u_rel;
    double P_injector_O, P_injector_F;
    double delta_p_injector_O, delta_p_injector_F;
    double delta_p_feed_O, delta_p_feed_F;
    double turbulence_intensity_mix;
    double MR;
    int    constraints_satisfied;
    int    iterations;                  /* outer spray-constraint iterations */
    int    feed_orifice_coupling_iters; /* last inner fixed-point iters */
} EdInjectorResult;

/* Per-branch impinging diagnostics for golden checks/dispatch use. */
ed_status_t ed_injector_solve(const EdEngineState *state,
                              double P_tank_O, double P_tank_F, double Pc,
                              EdInjectorResult *out);

ed_status_t ed_injector_impinging_solve(const EdEngineState *state,
                                        double P_tank_O, double P_tank_F, double Pc,
                                        EdInjectorResult *out);

#ifdef __cplusplus
}
#endif

#endif /* ED_INJECTOR_H */
