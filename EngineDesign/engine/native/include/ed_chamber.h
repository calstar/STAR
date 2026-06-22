/* ed_chamber.h - Module 1: chamber-pressure solve.
 *
 * Port target: ChamberSolver.solve()/residual() (engine/core/chamber_solver.py)
 * via closure.flows() -> injector.solve(), cea_cache.eval(), eta_cstar(), cooling.
 *
 * STATUS: API frozen. The residual chain depends on the combustion-physics and
 * cooling ports (engine/native/README.md "Staged plan"); until those land,
 * ed_chamber_solve returns ED_ERR_NOT_IMPLEMENTED. The foundational pieces it
 * will compose (CEA, Brent, feed-loss, discharge) are implemented and tested.
 */
#ifndef ED_CHAMBER_H
#define ED_CHAMBER_H

#include "ed_types.h"
#include "ed_state.h"
#include "ed_cea.h"
#include "ed_workspace.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Flat diagnostics produced by the chamber solve and consumed downstream by the
 * nozzle/evaluate and stability kernels. Mirrors the subset of ChamberSolver.solve
 * diagnostics dict that Layer 1 / nozzle / stability actually read. */
typedef struct EdChamberDiagnostics {
    double Pc;            /* Pa */
    double mdot_O;        /* kg/s */
    double mdot_F;        /* kg/s */
    double mdot_total;    /* kg/s */
    double MR;
    double cstar_ideal;   /* m/s */
    double cstar_actual;  /* m/s */
    double eta_cstar;
    double cooling_efficiency;
    double Tc;            /* K (effective, post-cooling) */
    double Tc_ideal;      /* K */
    double gamma;
    double R;             /* J/(kg.K) */
    double M;             /* kg/kmol */

    /* Injector diagnostics needed for Layer-1 penalties. */
    double momentum_ratio_R;
    double delta_P_injector_O; /* Pa */
    double delta_P_injector_F; /* Pa */
    double A_geom_O;           /* m^2 */
    double A_geom_F;           /* m^2 */
    double SMD;                /* m (Sauter mean diameter, max of branches) */
    double Cd_O;
    double Cd_F;
    double u_O;                /* m/s injection velocity */
    double u_F;

    int    converged;
    int    residual_iters;
} EdChamberDiagnostics;

/* Solve supply(Pc) == demand(Pc). Pc_guess_Pa = 0 selects the auto midpoint.
 * Allocation-free; uses ws for the residual history / warm-start bracket. */
ed_status_t ed_chamber_solve(const EdEngineState *state,
                             const EdCeaTables *cea,
                             double P_tank_O_Pa,
                             double P_tank_F_Pa,
                             double Pc_guess_Pa,
                             EdWorkspace *ws,
                             EdChamberDiagnostics *out);

#ifdef __cplusplus
}
#endif

#endif /* ED_CHAMBER_H */
