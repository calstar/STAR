/* ed_nozzle.c - Frozen-gas EXIT-STATE kernel: exit Mach (Newton on the area-Mach
 * relation) + isentropic exit/throat state. Port of mach_solver.py
 * (estimate_initial_mach / solve_mach_from_area_ratio, supersonic branch) with
 * the same Newton tolerance (1e-10) => golden agreement near machine precision.
 *
 * Exit/throat state only. Delivered thrust lives in ed_evaluate.c (RPA Cf_vac
 * basis); the retired momentum-method reconstruction that used to be computed
 * here was removed once nothing consumed it.
 */
#include "ed_nozzle.h"

#include <math.h>

/* A/A* = (1/M) * [ (2/(g+1)) * (1 + (g-1)/2 * M^2) ]^((g+1)/(2(g-1)))  */
static double area_mach_ratio(double M, double gamma) {
    double term = (2.0 / (gamma + 1.0)) * (1.0 + (gamma - 1.0) / 2.0 * M * M);
    double exponent = (gamma + 1.0) / (2.0 * (gamma - 1.0));
    return (1.0 / M) * pow(term, exponent);
}

/* d(A/A*)/dM = (A/A*) * 2(M^2 - 1) / ( M (2 + (g-1) M^2) )  (stable simplified form) */
static double area_mach_derivative(double M, double gamma, double A_Astar) {
    double numerator = 2.0 * (M * M - 1.0);
    double denominator = M * (2.0 + (gamma - 1.0) * M * M);
    return A_Astar * (numerator / denominator);
}

/* Supersonic initial guess — mirrors mach_solver.estimate_initial_mach. */
static double estimate_initial_mach(double eps, double gamma) {
    double M_guess;
    if (eps > 10.0) {
        double p = (gamma - 1.0) / 2.0;
        double prefactor = pow((gamma + 1.0) / (gamma - 1.0), (gamma + 1.0) / 4.0);
        M_guess = prefactor * pow(eps, p);
    } else if (eps > 1.5) {
        M_guess = 1.0 + sqrt(2.0 * (eps - 1.0) / (gamma + 1.0));
    } else {
        M_guess = 1.0 + 0.5 * (eps - 1.0);
    }
    return ed_max(M_guess, 1.0 + 1e-6);
}

/* Supersonic Newton solve of A/A*(M) = eps. Mirrors solve_mach_from_area_ratio. */
static int solve_exit_mach(double eps, double gamma, double *M_out) {
    const double tol = 1e-10;
    const int max_iter = 50;
    double M = estimate_initial_mach(eps, gamma);
    double error = INFINITY;

    for (int i = 0; i < max_iter; ++i) {
        double A_Astar = area_mach_ratio(M, gamma);
        error = A_Astar - eps;
        if (fabs(error) < tol) {
            *M_out = M;
            return 1;
        }
        double dA_dM = area_mach_derivative(M, gamma, A_Astar);
        if (fabs(dA_dM) < 1e-12) {
            /* Derivative too small: supersonic branch is increasing in M. */
            if (error > 0) M *= 0.99; else M *= 1.01;
        } else {
            double step = error / dA_dM;
            step = ed_clip(step, -0.5 * M, 0.5 * M);
            M = M - step;
        }
        if (M <= 1.0) M = 1.0 + 1e-6;
    }

    /* Match Python's relaxed final convergence check (tol * 10). */
    double A_final = area_mach_ratio(M, gamma);
    *M_out = M;
    return fabs(A_final - eps) < tol * 10.0;
}

ed_status_t ed_nozzle_solve(const EdNozzleInputs *in, EdNozzleResult *out) {
    if (!in || !out) return ED_ERR_INVALID_ARG;

    const double Pc = in->Pc;
    const double mdot = in->mdot_total;
    const double gamma = in->gamma;
    const double R = in->R;
    const double Tc = in->Tc;
    const double eps = in->eps;

    /* Input guards mirror the ValueError conditions in calculate_thrust. */
    if (!(in->A_throat > 0.0) || !(in->A_exit > 0.0) || !(eps > 1.0) ||
        !(gamma > 1.0) || !(R > 0.0) || !(Tc > 0.0) || !(Pc > 0.0) || !(mdot > 0.0)) {
        return ED_ERR_INVALID_ARG;
    }

    double M_exit = 0.0;
    if (!solve_exit_mach(eps, gamma, &M_exit) || M_exit <= 1.0) {
        return ED_ERR_NO_CONVERGE;
    }

    /* Isentropic exit state from chamber gamma (frozen). */
    double factor = 1.0 + (gamma - 1.0) / 2.0 * M_exit * M_exit;
    double P_exit = Pc * pow(factor, -gamma / (gamma - 1.0));
    double T_exit = Tc / factor;
    if (!ed_isfinite(P_exit) || P_exit < 0.0 || !ed_isfinite(T_exit) || T_exit <= 0.0) {
        return ED_ERR_NONFINITE;
    }

    double a_exit = sqrt(gamma * R * T_exit);
    double v_exit = M_exit * a_exit;
    if (!ed_isfinite(v_exit) || v_exit <= 0.0) return ED_ERR_NONFINITE;

    /* Throat (choked, M=1) isentropic conditions. */
    double throat_temp_ratio = 2.0 / (gamma + 1.0);
    double T_throat = Tc * throat_temp_ratio;
    double P_throat = Pc * pow(throat_temp_ratio, gamma / (gamma - 1.0));

    out->Cf_ideal = in->Cf_ideal;
    out->Cf_theoretical = in->nozzle_efficiency * in->Cf_ideal;
    out->P_exit = P_exit;
    out->T_exit = T_exit;
    out->v_exit = v_exit;
    out->M_exit = M_exit;
    out->P_throat = P_throat;
    out->T_throat = T_throat;
    out->converged = 1;
    return ED_OK;
}

const char *ed_nozzle_stage(void) { return "frozen"; }
