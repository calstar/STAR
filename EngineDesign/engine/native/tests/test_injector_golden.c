/* test_injector_golden.c - Stage 2 parity: ed_injector_solve (impinging) vs
 * Python ImpingingInjector.solve(), over tests/golden/injector_impinging.json.
 * Asserts mdot, Cd, momentum ratio R, jet areas, and SMD. */
#include "ed_injector.h"
#include "ed_test_util.h"

#ifndef ED_GOLDEN_DIR
#define ED_GOLDEN_DIR "."
#endif

static int g_fail = 0, g_checked = 0;
static const char *g_sbeg, *g_send;

static double S(const char *key) {
    double v = 0.0;
    if (!edt_find_double(g_sbeg, g_send, key, &v)) {
        fprintf(stderr, "  [FAIL] state missing %s\n", key);
        g_fail++;
    }
    return v;
}

static void load_disc(const char *p, EdDischarge *d) {
    char k[80];
#define D(field) (snprintf(k, sizeof k, "%s." #field, p), S(k))
    d->Cd_inf = D(Cd_inf); d->a_Re = D(a_Re); d->Cd_min = D(Cd_min);
    d->use_geometry_cd = (uint8_t)D(use_geometry_cd);
    d->d_ref_m = D(d_ref_m); d->d_min_m = D(d_min_m);
    d->cd_small_hole_exponent = D(cd_small_hole_exponent);
    d->cd_large_hole_log_gain = D(cd_large_hole_log_gain);
    d->cd_inf_max = D(cd_inf_max); d->cd_inf_min_geom = D(cd_inf_min_geom);
    d->use_pressure_correction = (uint8_t)D(use_pressure_correction);
    d->P_ref = D(P_ref); d->a_P = D(a_P);
    d->use_temperature_correction = (uint8_t)D(use_temperature_correction);
    d->T_ref = D(T_ref); d->a_T = D(a_T);
#undef D
}

static void load_feed(const char *p, EdFeed *f) {
    char k[64];
#define F(field) (snprintf(k, sizeof k, "%s." #field, p), S(k))
    f->d_inlet = F(d_inlet); f->A_hydraulic = F(A_hydraulic);
    f->K0 = F(K0); f->K1 = F(K1); f->phi_type = (ed_phi_type_t)(int)F(phi_type);
#undef F
}

static void load_fluid(const char *p, EdFluid *fl) {
    char k[64];
#define G(field) (snprintf(k, sizeof k, "%s." #field, p), S(k))
    fl->density = G(density); fl->viscosity = G(viscosity);
    fl->surface_tension = G(surface_tension); fl->temperature = G(temperature);
#undef G
}

static void load_imp(const char *p, EdImpingingBranch *b) {
    char k[64];
#define I(field) (snprintf(k, sizeof k, "%s." #field, p), S(k))
    b->n_elements = (int)I(n_elements); b->d_jet = I(d_jet);
    b->impingement_angle = I(impingement_angle); b->spacing = I(spacing);
#undef I
}

static void build_state(EdEngineState *st) {
    memset(st, 0, sizeof(*st));
    st->injector.type = (ed_injector_type_t)(int)S("injector.type");
    load_imp("imp_O", &st->injector.imp_O);
    load_imp("imp_F", &st->injector.imp_F);
    load_disc("discharge_O", &st->discharge_O);
    load_disc("discharge_F", &st->discharge_F);
    load_feed("feed_O", &st->feed_O);
    load_feed("feed_F", &st->feed_F);
    load_fluid("fluid_O", &st->fluid_O);
    load_fluid("fluid_F", &st->fluid_F);
    st->spray.smd_model = (ed_smd_model_t)(int)S("spray.smd_model");
    st->spray.smd_C = S("spray.smd_C");
    st->spray.smd_m = S("spray.smd_m");
    st->spray.smd_p = S("spray.smd_p");
    st->spray.smd_C_ingebo = S("spray.smd_C_ingebo");
    st->spray.smd_we_corr_max = S("spray.smd_we_corr_max");
    st->spray.chamber_gas_R = S("spray.chamber_gas_R");
    st->spray.chamber_gas_T = S("spray.chamber_gas_T");
    st->spray.spray_angle_model = (ed_spray_angle_model_t)(int)S("spray.spray_angle_model");
    st->spray.spray_angle_k = S("spray.spray_angle_k");
    st->spray.spray_angle_n = S("spray.spray_angle_n");
    st->spray.we_min = S("spray.we_min");
    st->spray.evap_K = S("spray.evap_K");
    st->spray.evap_x_star_limit = S("spray.evap_x_star_limit");
    st->spray.evap_use_constraint = (uint8_t)S("spray.evap_use_constraint");
    st->solver.closure_max_iterations = (int)S("solver.closure_max_iterations");
    st->solver.closure_Cd_reduction_factor = S("solver.closure_Cd_reduction_factor");
    st->cooling.regen_enabled = (uint8_t)S("cooling.regen_enabled");
}

static void cmp(const char *tag, int idx, double got, double want, double rtol, double atol) {
    g_checked++;
    if (!edt_close(got, want, rtol, atol)) {
        fprintf(stderr, "  [FAIL] s%-2d %-16s got=%.10g want=%.10g\n", idx, tag, got, want);
        g_fail++;
    }
}

int main(void) {
    char *js = edt_slurp(ED_GOLDEN_DIR "/injector_impinging.json", NULL);
    if (!js) { fprintf(stderr, "FAIL: cannot load injector_impinging.json\n"); return 1; }

    /* state region */
    const char *sp = strstr(js, "\"state\"");
    if (!sp) { fprintf(stderr, "FAIL: no state\n"); return 1; }
    g_sbeg = strchr(sp, '{');
    g_send = strchr(g_sbeg, '}');  /* flat object: first '}' closes it */

    EdEngineState st;
    build_state(&st);

    /* samples region (after state object) */
    const char *p = strstr(g_send, "\"samples\""), *e;
    int n = 0;
    while (p && (p = edt_next_object(p, &e)) != NULL) {
        double P_O, P_F, Pc;
        if (!(edt_find_double(p, e, "P_tank_O", &P_O) &&
              edt_find_double(p, e, "P_tank_F", &P_F) &&
              edt_find_double(p, e, "Pc", &Pc))) { p = e + 1; continue; }

        EdInjectorResult r;
        ed_status_t rc = ed_injector_solve(&st, P_O, P_F, Pc, &r);
        if (rc != ED_OK) {
            fprintf(stderr, "  [FAIL] s%d solve rc=%d\n", n, rc);
            g_fail++; p = e + 1; n++; continue;
        }
        double w;
#define CHK(key, field, rt, at) do { if (edt_find_double(p, e, key, &w)) cmp(key, n, r.field, w, rt, at); } while (0)
        CHK("mdot_O", mdot_O, 1e-6, 1e-9);
        CHK("mdot_F", mdot_F, 1e-6, 1e-9);
        CHK("Cd_O", Cd_O, 1e-6, 1e-9);
        CHK("Cd_F", Cd_F, 1e-6, 1e-9);
        CHK("momentum_ratio_R", momentum_ratio_R, 1e-6, 1e-9);
        CHK("A_geom_O", A_geom_O, 1e-9, 1e-15);
        CHK("A_geom_F", A_geom_F, 1e-9, 1e-15);
        CHK("D32_O", D32_O, 1e-6, 1e-12);
        CHK("D32_F", D32_F, 1e-6, 1e-12);
        CHK("We_O", We_O, 1e-6, 1e-9);
        CHK("We_F", We_F, 1e-6, 1e-9);
        CHK("J", J, 1e-6, 1e-9);
        CHK("theta", theta, 1e-6, 1e-9);
        CHK("x_star", x_star, 1e-6, 1e-12);
#undef CHK
        p = e + 1; n++;
    }

    free(js);
    printf("injector golden: %d samples, %d checks, %d failures\n", n, g_checked, g_fail);
    if (n == 0) { fprintf(stderr, "FAIL: no samples\n"); return 1; }
    return g_fail ? 1 : 0;
}
