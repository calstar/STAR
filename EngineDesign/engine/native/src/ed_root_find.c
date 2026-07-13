/* ed_root_find.c - Brent's method, allocation-free.
 *
 * Replaces scipy.optimize.brentq in the chamber solve. Brent converges to the
 * same root (defined by the residual) within tolerance, so the solved Pc matches
 * Python to far better than the 1e-4 parity target regardless of solver internals.
 *
 * Classic Brent (Numerical Recipes / scipy zeros.c structure): inverse quadratic
 * interpolation with secant and bisection fallback, guaranteed bracketing.
 */
#include "ed_root_find.h"

#include <float.h>

ed_status_t ed_brentq(ed_root_fn f, void *ctx, double a, double b,
                      const ed_root_opts *opts, ed_root_result *out) {
    if (!f || !out) return ED_ERR_INVALID_ARG;

    double xtol = 2e-12, rtol = 4.0 * DBL_EPSILON;
    int max_iter = 100;
    if (opts) {
        if (opts->xtol > 0) xtol = opts->xtol;
        if (opts->rtol > 0) rtol = opts->rtol;
        if (opts->max_iter > 0) max_iter = opts->max_iter;
    }

    double fa = f(a, ctx);
    double fb = f(b, ctx);
    out->iterations = 0;
    out->converged = 0;

    if (!isfinite(fa) || !isfinite(fb)) {
        out->root = a; out->f_root = fa;
        return ED_ERR_NONFINITE;
    }
    /* Exact hit at an endpoint. */
    if (fa == 0.0) { out->root = a; out->f_root = 0.0; out->converged = 1; return ED_OK; }
    if (fb == 0.0) { out->root = b; out->f_root = 0.0; out->converged = 1; return ED_OK; }
    if (ed_sign(fa) == ed_sign(fb)) {
        out->root = a; out->f_root = fa;
        return ED_ERR_NO_BRACKET;
    }

    double c = a, fc = fa, d = b - a, e = d;

    for (int iter = 0; iter < max_iter; ++iter) {
        out->iterations = iter + 1;

        if (ed_sign(fb) == ed_sign(fc)) {
            c = a; fc = fa; d = b - a; e = d;
        }
        if (fabs(fc) < fabs(fb)) {
            a = b;  b = c;  c = a;
            fa = fb; fb = fc; fc = fa;
        }

        const double tol = 2.0 * rtol * fabs(b) + 0.5 * xtol; /* scipy: convergence band */
        const double m = 0.5 * (c - b);

        if (fb == 0.0 || fabs(m) <= tol) {
            out->root = b; out->f_root = fb; out->converged = 1;
            return ED_OK;
        }

        if (fabs(e) < tol || fabs(fa) <= fabs(fb)) {
            /* Bisection */
            d = m; e = m;
        } else {
            double s = fb / fa, p, q;
            if (a == c) {
                /* Secant */
                p = 2.0 * m * s;
                q = 1.0 - s;
            } else {
                /* Inverse quadratic interpolation */
                const double qa = fa / fc, r = fb / fc;
                p = s * (2.0 * m * qa * (qa - r) - (b - a) * (r - 1.0));
                q = (qa - 1.0) * (r - 1.0) * (s - 1.0);
            }
            if (p > 0.0) q = -q;
            else         p = -p;

            if (2.0 * p < ed_min(3.0 * m * q - fabs(tol * q), fabs(e * q))) {
                e = d; d = p / q;
            } else {
                d = m; e = m; /* fall back to bisection */
            }
        }

        a = b; fa = fb;
        if (fabs(d) > tol) b += d;
        else               b += (m > 0.0 ? tol : -tol);

        fb = f(b, ctx);
        if (!isfinite(fb)) {
            out->root = b; out->f_root = fb;
            return ED_ERR_NONFINITE;
        }
    }

    out->root = b; out->f_root = fb;
    return ED_ERR_NO_CONVERGE;
}
