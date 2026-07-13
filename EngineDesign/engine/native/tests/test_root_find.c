/* test_root_find.c - Unit tests for ed_brentq against analytic roots. */
#include "ed_root_find.h"
#include <stdio.h>
#include <math.h>

static int g_fail = 0;

static double f_cubic(double x, void *c) { (void)c; return x * x * x - 2.0 * x - 5.0; }     /* root ~2.0945514815 */
static double f_sin(double x, void *c)   { (void)c; return sin(x); }                          /* root pi in [3,4] */
static double f_lin(double x, void *c)   { (void)c; return 3.0 * x - 6.0; }                   /* root 2 */
static double f_exp(double x, void *c)   { (void)c; return exp(x) - 5.0; }                    /* root ln5 */

static void expect_root(const char *name, ed_root_fn f, double a, double b, double want) {
    ed_root_opts o = { .xtol = 1e-12, .rtol = 1e-14, .max_iter = 100 };
    ed_root_result r;
    ed_status_t rc = ed_brentq(f, NULL, a, b, &o, &r);
    if (rc != ED_OK || !r.converged) {
        fprintf(stderr, "  [FAIL] %-8s rc=%d converged=%d\n", name, rc, r.converged);
        g_fail++;
        return;
    }
    if (fabs(r.root - want) > 1e-9) {
        fprintf(stderr, "  [FAIL] %-8s root=%.12g want=%.12g (iters=%d)\n",
                name, r.root, want, r.iterations);
        g_fail++;
        return;
    }
    printf("  [ok]   %-8s root=%.12g iters=%d |f|=%.2e\n", name, r.root, r.iterations, fabs(r.f_root));
}

int main(void) {
    expect_root("cubic", f_cubic, 1.0, 3.0, 2.0945514815423265);
    expect_root("sin",   f_sin,   3.0, 4.0, M_PI);
    expect_root("linear",f_lin,   0.0, 10.0, 2.0);
    expect_root("exp",   f_exp,   0.0, 5.0, log(5.0));

    /* No-bracket detection. */
    ed_root_result r;
    if (ed_brentq(f_lin, NULL, 5.0, 10.0, NULL, &r) != ED_ERR_NO_BRACKET) {
        fprintf(stderr, "  [FAIL] expected ED_ERR_NO_BRACKET\n");
        g_fail++;
    } else {
        printf("  [ok]   no-bracket detected\n");
    }

    /* Endpoint-root detection. */
    if (ed_brentq(f_lin, NULL, 2.0, 10.0, NULL, &r) != ED_OK || fabs(r.root - 2.0) > 1e-15) {
        fprintf(stderr, "  [FAIL] endpoint root not detected\n");
        g_fail++;
    } else {
        printf("  [ok]   endpoint root detected\n");
    }

    printf("root_find: %s\n", g_fail ? "FAILURES" : "all passed");
    return g_fail ? 1 : 0;
}
