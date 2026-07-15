/* test_feed_discharge.c - Parity of ed_feed_loss + ed_discharge vs Python.
 *
 * Reads tests/golden/component_samples.json (export_component_golden.py), which
 * carries config fields + inputs + the live-Python expected output per sample.
 */
#include "ed_feed_loss.h"
#include "ed_discharge.h"
#include "ed_test_util.h"

#ifndef ED_GOLDEN_DIR
#define ED_GOLDEN_DIR "."
#endif

static int g_fail = 0, g_checked = 0;

static double need(const char *o, const char *e, const char *k) {
    double v = 0.0;
    if (!edt_find_double(o, e, k, &v)) {
        fprintf(stderr, "  [FAIL] missing key %s\n", k);
        g_fail++;
    }
    return v;
}

static void fill_feed(const char *o, const char *e, EdFeed *f) {
    f->d_inlet = need(o, e, "d_inlet");
    f->A_hydraulic = need(o, e, "A_hydraulic");
    f->K0 = need(o, e, "K0");
    f->K1 = need(o, e, "K1");
    f->phi_type = (ed_phi_type_t)(int)need(o, e, "phi_type");
}

static void fill_disc(const char *o, const char *e, EdDischarge *d) {
    d->Cd_inf = need(o, e, "Cd_inf");
    d->a_Re = need(o, e, "a_Re");
    d->Cd_min = need(o, e, "Cd_min");
    d->use_geometry_cd = (uint8_t)(int)need(o, e, "use_geometry_cd");
    d->d_ref_m = need(o, e, "d_ref_m");
    d->d_min_m = need(o, e, "d_min_m");
    d->cd_small_hole_exponent = need(o, e, "cd_small_hole_exponent");
    d->cd_large_hole_log_gain = need(o, e, "cd_large_hole_log_gain");
    d->cd_inf_max = need(o, e, "cd_inf_max");
    d->cd_inf_min_geom = need(o, e, "cd_inf_min_geom");
    d->use_pressure_correction = (uint8_t)(int)need(o, e, "use_pressure_correction");
    d->P_ref = need(o, e, "P_ref");
    d->a_P = need(o, e, "a_P");
    d->use_temperature_correction = (uint8_t)(int)need(o, e, "use_temperature_correction");
    d->T_ref = need(o, e, "T_ref");
    d->a_T = need(o, e, "a_T");
}

static void cmp(const char *tag, double got, double want) {
    g_checked++;
    if (!edt_close(got, want, 1e-9, 1e-9)) {
        fprintf(stderr, "  [FAIL] %-12s got=%.12g want=%.12g\n", tag, got, want);
        g_fail++;
    }
}

/* Returns region [*beg,*reg_end) for the array following "key" up to next_key. */
static void section(const char *buf, const char *key, const char *next_key,
                    const char **beg, const char **reg_end) {
    char pat[48];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *s = strstr(buf, pat);
    *beg = s ? s + strlen(pat) : NULL;
    if (next_key) {
        snprintf(pat, sizeof pat, "\"%s\"", next_key);
        const char *n = strstr(buf, pat);
        *reg_end = n ? n : buf + strlen(buf);
    } else {
        *reg_end = buf + strlen(buf);
    }
}

int main(void) {
    char *js = edt_slurp(ED_GOLDEN_DIR "/component_samples.json", NULL);
    if (!js) { fprintf(stderr, "FAIL: cannot load component_samples.json\n"); return 1; }

    const char *beg, *reg_end, *p, *e;

    /* feed loss */
    section(js, "feed", "cd_inf", &beg, &reg_end);
    p = beg;
    while (p && (p = edt_next_object(p, &e)) != NULL && p < reg_end) {
        EdFeed f;
        fill_feed(p, e, &f);
        double mdot = need(p, e, "mdot"), rho = need(p, e, "rho"), P = need(p, e, "P_tank");
        double want = need(p, e, "expected");
        cmp("delta_p_feed", ed_delta_p_feed(mdot, rho, &f, P), want);
        p = e + 1;
    }

    /* cd_inf_from_orifice_diameter */
    section(js, "cd_inf", "cd_from_re", &beg, &reg_end);
    p = beg;
    while (p && (p = edt_next_object(p, &e)) != NULL && p < reg_end) {
        EdDischarge d;
        fill_disc(p, e, &d);
        double dh = need(p, e, "d_hyd"), want = need(p, e, "expected");
        cmp("cd_inf", ed_cd_inf_from_orifice_diameter(dh, &d), want);
        p = e + 1;
    }

    /* cd_from_re */
    section(js, "cd_from_re", NULL, &beg, &reg_end);
    p = beg;
    while (p && (p = edt_next_object(p, &e)) != NULL && p < reg_end) {
        EdDischarge d;
        fill_disc(p, e, &d);
        double Re = need(p, e, "Re"), Pin = need(p, e, "P_inlet"),
               Tin = need(p, e, "T_inlet"), dh = need(p, e, "d_hyd");
        double want = need(p, e, "expected");
        cmp("cd_from_re", ed_cd_from_re(Re, &d, Pin, Tin, dh), want);
        p = e + 1;
    }

    free(js);
    printf("feed/discharge: checked %d, %d failures\n", g_checked, g_fail);
    return g_fail ? 1 : 0;
}
