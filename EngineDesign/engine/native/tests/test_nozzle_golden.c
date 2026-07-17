/* test_nozzle_golden.c - Parity of ed_nozzle_solve vs the Python FROZEN nozzle.
 *
 * Loads tests/golden/nozzle_golden.json (produced by tools/export_nozzle_golden.py):
 * each flat object carries the CEA-derived nozzle inputs + the expected frozen
 * outputs from runner.evaluate(use_shifting_equilibrium=False). Identical formulas
 * and identical thermo inputs => agreement near machine precision; tolerance is
 * rtol 1e-7 (far tighter than the 1e-3 program parity target).
 */
#include "ed_nozzle.h"
#include "ed_test_util.h"

#ifndef ED_GOLDEN_DIR
#define ED_GOLDEN_DIR "."
#endif

static int g_fail = 0;

static void check(const char *name, double got, double want, int idx) {
    if (!edt_close(got, want, 1e-7, 1e-6)) {
        fprintf(stderr, "  [FAIL] sample %d %-12s got=%.12g want=%.12g (rel=%.2e)\n",
                idx, name, got, want, fabs(got - want) / (fabs(want) + 1e-30));
        g_fail++;
    }
}

int main(void) {
    size_t len = 0;
    char *js = edt_slurp(ED_GOLDEN_DIR "/nozzle_golden.json", &len);
    if (!js) {
        fprintf(stderr, "FAIL: cannot load nozzle_golden.json from %s\n", ED_GOLDEN_DIR);
        return 1;
    }

    int n = 0;
    const char *p = js, *end;
    while ((p = edt_next_object(p, &end)) != NULL) {
        EdNozzleInputs in;
        double F, Isp, Cf_actual, P_exit, T_exit, v_exit, M_exit, P_throat, T_throat;
        int ok =
            edt_find_double(p, end, "Pc", &in.Pc) &&
            edt_find_double(p, end, "mdot_total", &in.mdot_total) &&
            edt_find_double(p, end, "A_throat", &in.A_throat) &&
            edt_find_double(p, end, "A_exit", &in.A_exit) &&
            edt_find_double(p, end, "eps", &in.eps) &&
            edt_find_double(p, end, "Pa", &in.Pa) &&
            edt_find_double(p, end, "nozzle_efficiency", &in.nozzle_efficiency) &&
            edt_find_double(p, end, "Cf_ideal", &in.Cf_ideal) &&
            edt_find_double(p, end, "gamma", &in.gamma) &&
            edt_find_double(p, end, "R", &in.R) &&
            edt_find_double(p, end, "Tc", &in.Tc) &&
            edt_find_double(p, end, "F", &F) &&
            edt_find_double(p, end, "Cf_actual", &Cf_actual) &&
            edt_find_double(p, end, "P_exit", &P_exit) &&
            edt_find_double(p, end, "T_exit", &T_exit) &&
            edt_find_double(p, end, "v_exit", &v_exit) &&
            edt_find_double(p, end, "M_exit", &M_exit) &&
            edt_find_double(p, end, "P_throat", &P_throat) &&
            edt_find_double(p, end, "T_throat", &T_throat) &&
            edt_find_double(p, end, "Isp", &Isp);
        if (ok) {
            EdNozzleResult r;
            if (ed_nozzle_solve(&in, &r) != ED_OK) {
                fprintf(stderr, "  [FAIL] sample %d ed_nozzle_solve returned error\n", n);
                g_fail++;
            } else {
                check("M_exit", r.M_exit, M_exit, n);
                check("P_exit", r.P_exit, P_exit, n);
                check("T_exit", r.T_exit, T_exit, n);
                check("v_exit", r.v_exit, v_exit, n);
                check("P_throat", r.P_throat, P_throat, n);
                check("T_throat", r.T_throat, T_throat, n);
                check("F", r.F, F, n);
                check("Cf_actual", r.Cf_actual, Cf_actual, n);
                check("Isp", r.Isp, Isp, n);
            }
            n++;
        }
        p = end + 1;
    }

    free(js);
    printf("checked %d nozzle samples, %d failures\n", n, g_fail);
    if (n == 0) { fprintf(stderr, "FAIL: no samples parsed\n"); return 1; }
    return g_fail ? 1 : 0;
}
