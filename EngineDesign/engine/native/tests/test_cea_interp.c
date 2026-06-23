/* test_cea_interp.c - Parity of ed_cea_eval vs Python CEACache.eval().
 *
 * Loads tests/golden/cea_tables.bin + cea_samples.json (produced by
 * export_cea_tables.py) and asserts each of the 6 properties matches the Python
 * reference. Same float64 tables + identical formula => agreement near machine
 * precision; tolerance is rtol 1e-9 (far tighter than the 1e-4 spec target).
 */
#include "ed_cea.h"
#include "ed_test_util.h"

#ifndef ED_GOLDEN_DIR
#define ED_GOLDEN_DIR "."
#endif

static int g_fail = 0;

static void check(const char *name, double got, double want, int idx) {
    if (!edt_close(got, want, 1e-9, 1e-7)) {
        fprintf(stderr, "  [FAIL] sample %d %-12s got=%.12g want=%.12g\n",
                idx, name, got, want);
        g_fail++;
    }
}

int main(void) {
    EdCeaTables t;
    if (ed_cea_load(ED_GOLDEN_DIR "/cea_tables.bin", &t) != ED_OK) {
        fprintf(stderr, "FAIL: cannot load cea_tables.bin from %s\n", ED_GOLDEN_DIR);
        return 1;
    }
    printf("loaded CEA grid %zux%zux%zu  Pc[%.0f..%.0f] MR[%.2f..%.2f] eps[%.2f..%.2f]\n",
           t.n_pc, t.n_mr, t.n_eps, t.Pc_min, t.Pc_max, t.MR_min, t.MR_max, t.eps_min, t.eps_max);

    size_t len = 0;
    char *js = edt_slurp(ED_GOLDEN_DIR "/cea_samples.json", &len);
    if (!js) {
        fprintf(stderr, "FAIL: cannot load cea_samples.json\n");
        ed_cea_free(&t);
        return 1;
    }

    int n = 0;
    const char *p = js, *end;
    while ((p = edt_next_object(p, &end)) != NULL) {
        double MR, Pc, Pa, eps;
        double cstar, Cf, Tc, gamma, R, M;
        if (edt_find_double(p, end, "MR", &MR) &&
            edt_find_double(p, end, "Pc", &Pc) &&
            edt_find_double(p, end, "Pa", &Pa) &&
            edt_find_double(p, end, "eps", &eps) &&
            edt_find_double(p, end, "cstar_ideal", &cstar) &&
            edt_find_double(p, end, "Cf_ideal", &Cf) &&
            edt_find_double(p, end, "Tc", &Tc) &&
            edt_find_double(p, end, "gamma", &gamma) &&
            edt_find_double(p, end, "R", &R) &&
            edt_find_double(p, end, "M", &M)) {
            EdCeaResult r;
            if (ed_cea_eval(&t, MR, Pc, Pa, eps, &r) != ED_OK) {
                fprintf(stderr, "  [FAIL] sample %d eval returned error\n", n);
                g_fail++;
            } else {
                check("cstar_ideal", r.cstar_ideal, cstar, n);
                check("Cf_ideal", r.Cf_ideal, Cf, n);
                check("Tc", r.Tc, Tc, n);
                check("gamma", r.gamma, gamma, n);
                check("R", r.R, R, n);
                check("M", r.M, M, n);
            }
            n++;
        }
        p = end + 1;
    }

    free(js);
    ed_cea_free(&t);

    printf("checked %d samples, %d failures\n", n, g_fail);
    if (n == 0) { fprintf(stderr, "FAIL: no samples parsed\n"); return 1; }
    return g_fail ? 1 : 0;
}
