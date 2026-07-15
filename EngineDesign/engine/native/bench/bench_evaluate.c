/* bench_evaluate.c - Standalone timing harness.
 *
 * Final target (per spec): load state_impinging.bin + cea_tables.bin, warm up
 * 1000 iters, time 100k (ed_evaluate + ed_stability_analyze) calls, print median
 * ns/eval and the implied speedup vs the Python baseline.
 *
 * STAGE 1: ed_evaluate/ed_stability are not yet implemented, so this harness
 * times the kernels that ARE on the hot path and already ported — the CEA
 * trilinear lookup (target <100 ns) and a representative bracketed Brent solve —
 * to validate the measurement rig and establish per-component baselines. The full
 * combined-path timing turns on automatically once ed_evaluate returns ED_OK.
 */
#include "ed_cea.h"
#include "ed_root_find.h"
#include "ed_evaluate.h"
#include <stdio.h>
#include <stdlib.h>
#include <math.h>

#ifndef ED_GOLDEN_DIR
#define ED_GOLDEN_DIR "."
#endif

/* Portable monotonic high-resolution clock (Windows QPC / POSIX clock_gettime). */
#if defined(_WIN32)
#include <windows.h>
static double now_ns(void) {
    static LARGE_INTEGER freq;
    if (freq.QuadPart == 0) QueryPerformanceFrequency(&freq);
    LARGE_INTEGER c; QueryPerformanceCounter(&c);
    return (double)c.QuadPart * 1e9 / (double)freq.QuadPart;
}
#else
#include <time.h>
static double now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1e9 + (double)ts.tv_nsec;
}
#endif

static int cmp_d(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return (x > y) - (x < y);
}

/* A monotone residual standing in for the chamber supply-demand balance, used to
 * exercise the Brent solver at a realistic ~10-30 iteration count. */
static double demo_residual(double Pc, void *ctx) {
    double k = *(double *)ctx;
    return 6.0 - k * Pc * 1e-6 - 0.3 * Pc * 1e-6; /* root near a few MPa */
}

int main(void) {
    EdCeaTables cea;
    if (ed_cea_load(ED_GOLDEN_DIR "/cea_tables.bin", &cea) != ED_OK) {
        fprintf(stderr, "bench: cannot load cea_tables.bin\n");
        return 1;
    }

    const int N = 100000, WARM = 1000, REPS = 20;
    double *samp = (double *)malloc(sizeof(double) * REPS);

    /* Per-call latency is below clock_gettime granularity, so each rep times the
     * whole N-iteration batch and divides; we report the median rep. */

    /* ---- CEA lookup ---- */
    EdCeaResult r;
    double acc = 0.0;
    for (int i = 0; i < WARM; ++i) ed_cea_eval(&cea, 2.8, 4.0e6, 101325.0, 6.0, &r);
    for (int rep = 0; rep < REPS; ++rep) {
        double t0 = now_ns();
        for (int i = 0; i < N; ++i) {
            double MR = 2.5 + (double)(i % 100) / 100.0 * 1.5;
            double Pc = 1.5e6 + (double)(i % 137) / 137.0 * 6.0e6;
            double eps = 4.0 + (double)(i % 53) / 53.0 * 10.0;
            ed_cea_eval(&cea, MR, Pc, 101325.0, eps, &r);
            acc += r.cstar_ideal;
        }
        samp[rep] = (now_ns() - t0) / N;
    }
    qsort(samp, REPS, sizeof(double), cmp_d);
    printf("ed_cea_eval         : median %6.1f ns/call  (sink=%.3g)\n", samp[REPS / 2], acc);

    /* ---- Brent solve ---- */
    ed_root_opts opt = { .xtol = 1.0, .rtol = 1e-9, .max_iter = 100 };
    long iters = 0; acc = 0.0;
    for (int rep = 0; rep < REPS; ++rep) {
        double t0 = now_ns();
        for (int i = 0; i < N; ++i) {
            double k = 1.0 + (double)(i % 100) / 100.0;
            ed_root_result rr;
            ed_brentq(demo_residual, &k, 1.0e5, 8.0e6, &opt, &rr);
            if (rep == 0) iters += rr.iterations;
            acc += rr.root;
        }
        samp[rep] = (now_ns() - t0) / N;
    }
    qsort(samp, REPS, sizeof(double), cmp_d);
    printf("ed_brentq (residual): median %6.1f ns/call  avg %.1f iters  (sink=%.3g)\n",
           samp[REPS / 2], (double)iters / N, acc);

    /* ---- Full combined path (auto-enables when implemented) ---- */
    EdEngineState st; EdWorkspace ws; ed_workspace_reset(&ws);
    EdEvaluateResult ev;
    ed_status_t rc = ed_evaluate(&st, &cea, 5e6, 5e6, 101325.0, 0.0, &ws, &ev);
    if (rc == ED_ERR_NOT_IMPLEMENTED) {
        printf("ed_evaluate+stability: pending (combustion/cooling/nozzle/stability stage)\n");
    } else {
        for (int i = 0; i < WARM; ++i) ed_evaluate(&st, &cea, 5e6, 5e6, 101325.0, 0.0, &ws, &ev);
        for (int rep = 0; rep < REPS; ++rep) {
            double t0 = now_ns();
            for (int i = 0; i < N; ++i)
                ed_evaluate(&st, &cea, 5e6, 5e6, 101325.0, 0.0, &ws, &ev);
            samp[rep] = (now_ns() - t0) / N;
        }
        qsort(samp, REPS, sizeof(double), cmp_d);
        printf("ed_evaluate         : median %6.1f ns/call\n", samp[REPS / 2]);
    }

    free(samp);
    ed_cea_free(&cea);
    return 0;
}
