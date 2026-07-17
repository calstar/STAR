/* ed_nozzle.h - Module 2a: frozen-gas nozzle (exit Mach -> thrust / Isp).
 *
 * Port target: nozzle.py::calculate_thrust with use_shifting_equilibrium=False
 * (the supersonic isentropic core + mach_solver.py::solve_exit_mach_robust).
 *
 * SCOPE (Phase 1a): FROZEN gas only — exit properties use the chamber gamma/R.
 * The Python shifting-equilibrium correction (~1% on F/Isp) is intentionally NOT
 * ported here; it remains the authoritative Python path used at Layer-1
 * finalization. This kernel is the fast inner-loop nozzle, validated against the
 * FROZEN branch of the Python oracle (see tools/export_nozzle_golden.py). No
 * Python physics is removed. Shifting-equilibrium-in-C is tracked as Phase 1b.
 */
#ifndef ED_NOZZLE_H
#define ED_NOZZLE_H

#include "ed_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Inputs the nozzle consumes. The thermo (Cf_ideal, gamma, R, Tc) is the CEA
 * result at (MR, Pc, Pa, eps) — i.e. exactly what nozzle.py reads from
 * cea_cache.eval() before the isentropic expansion. */
typedef struct EdNozzleInputs {
    double Pc;                /* chamber pressure [Pa] */
    double mdot_total;        /* total mass flow [kg/s] */
    double A_throat;          /* [m^2] */
    double A_exit;            /* [m^2] */
    double eps;               /* expansion ratio A_exit/A_throat (>1) */
    double Pa;                /* ambient pressure [Pa] */
    double nozzle_efficiency; /* scales Cf_theoretical only (frozen F is independent) */
    double Cf_ideal;          /* CEA ideal thrust coefficient */
    double gamma;             /* chamber gamma (>1) */
    double R;                 /* gas constant [J/(kg.K)] */
    double Tc;                /* chamber temperature [K] */
} EdNozzleInputs;

/* Flat result. Mirrors the nozzle keys runner.evaluate() forwards to Layer 1. */
typedef struct EdNozzleResult {
    double F;            /* total thrust [N] = momentum + pressure */
    double F_momentum;   /* [N] */
    double F_pressure;   /* [N] */
    double Cf_actual;    /* F / (Pc * A_throat) */
    double Cf_ideal;     /* echoed from input */
    double Cf_theoretical; /* nozzle_efficiency * Cf_ideal */
    double P_exit;       /* [Pa] */
    double T_exit;       /* [K] */
    double v_exit;       /* [m/s] */
    double M_exit;       /* exit Mach (>1) */
    double P_throat;     /* [Pa] */
    double T_throat;     /* [K] */
    double Isp;          /* [s] */
    int    converged;
} EdNozzleResult;

/* Solve the frozen nozzle. Returns ED_OK on success; ED_ERR_INVALID_ARG on bad
 * geometry/thermo, ED_ERR_NO_CONVERGE if the exit-Mach Newton fails. */
ed_status_t ed_nozzle_solve(const EdNozzleInputs *in, EdNozzleResult *out);

/* Build tag (kept for symbol-stability with the former placeholder TU). */
const char *ed_nozzle_stage(void);

#ifdef __cplusplus
}
#endif

#endif /* ED_NOZZLE_H */
