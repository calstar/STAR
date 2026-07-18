/* ed_nozzle.h - frozen-gas EXIT-STATE kernel (exit Mach + isentropic exit props).
 *
 * Port of the supersonic isentropic core of nozzle.py (area-Mach Newton from
 * mach_solver.py + frozen exit state from chamber gamma/R). Python computes the
 * same frozen exit state — both sides report it as display-only.
 *
 * NOTE (2026-07): the F/Isp/Cf fields in EdNozzleResult are the RETIRED
 * momentum-method reconstruction and are NOT consumed anywhere — delivered
 * thrust is computed in ed_evaluate.c as zeta_n*Cf_vac*Pc*At - Pa*Ae (RPA
 * basis, matching nozzle.py; see docs/thrust_efficiency_bug_analysis.md).
 * ed_evaluate reads only the exit/throat state from this kernel. The legacy
 * fields remain so the golden vectors (nozzle_golden.json) still pin the
 * arithmetic; drop them together with a golden re-export if EdNozzleResult
 * ever changes shape.
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
