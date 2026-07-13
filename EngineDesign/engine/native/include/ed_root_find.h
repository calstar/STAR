/* ed_root_find.h - Allocation-free bracketed root finder (Brent's method).
 *
 * Replaces scipy.optimize.brentq in the chamber-pressure solve. Supports an
 * optional warm-start bracket and records the iteration count. The callback is a
 * plain function pointer + void* context so the residual stays inlinable and
 * heap-free.
 */
#ifndef ED_ROOT_FIND_H
#define ED_ROOT_FIND_H

#include "ed_types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef double (*ed_root_fn)(double x, void *ctx);

typedef struct {
    double xtol;        /* absolute tolerance on x (brentq xtol) */
    double rtol;        /* relative tolerance on x (brentq rtol) */
    int    max_iter;    /* iteration cap */
} ed_root_opts;

typedef struct {
    double root;
    double f_root;
    int    iterations;
    int    converged;   /* 1 if converged within tolerance */
} ed_root_result;

/* Brent's method on [a, b]; requires f(a) and f(b) to have opposite signs.
 * Returns ED_ERR_NO_BRACKET if not, ED_ERR_NONFINITE on non-finite evaluations.
 * Matches scipy brentq defaults: xtol=2e-12, rtol=4*eps when opts==NULL. */
ed_status_t ed_brentq(ed_root_fn f, void *ctx, double a, double b,
                      const ed_root_opts *opts, ed_root_result *out);

#ifdef __cplusplus
}
#endif

#endif /* ED_ROOT_FIND_H */
