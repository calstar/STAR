/* test_residual_golden.c - Parity of the Stage-3 residual physics vs Python:
 * ed_combustion_efficiency_advanced (eta components) and ed_cooling_evaluate
 * (ablative cooling_eff). Reads tests/golden/residual_samples.json. */
#include <math.h>

#include "ed_combustion.h"
#include "ed_cooling.h"
#include "ed_test_util.h"

#ifndef ED_GOLDEN_DIR
#define ED_GOLDEN_DIR "."
#endif

static int g_fail = 0, g_checked = 0;
static double g_worst = 0.0;

static double need(const char *o, const char *e, const char *k) {
    double v = 0.0;
    if (!edt_find_double(o, e, k, &v)) { fprintf(stderr, "  [FAIL] missing %s\n", k); g_fail++; }
    return v;
}

static void cmp(const char *tag, double got, double want) {
    g_checked++;
    double rel = fabs(want) > 1e-12 ? fabs(got - want) / fabs(want) : fabs(got - want);
    if (rel > g_worst) g_worst = rel;
    if (!edt_close(got, want, 1e-7, 1e-6)) {
        fprintf(stderr, "  [FAIL] %-14s got=%.10g want=%.10g rel=%.2e\n", tag, got, want, rel);
        g_fail++;
    }
}

/* locate the flat object that follows "key" */
static const char *obj_for(const char *buf, const char *key, const char **end) {
    char pat[40]; snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(buf, pat);
    if (!p) return NULL;
    return edt_next_object(p, end);
}

int main(void) {
    char *js = edt_slurp(ED_GOLDEN_DIR "/residual_samples.json", NULL);
    if (!js) { fprintf(stderr, "FAIL: cannot load residual_samples.json\n"); return 1; }

    const char *ce, *cl, *ge;
    const char *co = obj_for(js, "comb", &ce);
    const char *cc = obj_for(js, "cooling", &cl);
    const char *go = obj_for(js, "geom", &ge);
    if (!co || !cc || !go) { fprintf(stderr, "FAIL: missing comb/cooling/geom\n"); return 1; }

    EdEngineState st; memset(&st, 0, sizeof st);
    EdCombustionEff *cb = &st.comb;
    cb->model = (ed_eff_model_t)(int)need(co, ce, "model");
    cb->C = need(co, ce, "C"); cb->K = need(co, ce, "K");
    cb->tau_ref = need(co, ce, "tau_ref"); cb->tau_ref_P = need(co, ce, "tau_ref_P");
    cb->tau_ref_T = need(co, ce, "tau_ref_T"); cb->n_pressure = need(co, ce, "n_pressure");
    cb->has_tau_Tc_floor = (uint8_t)(int)need(co, ce, "has_tau_Tc_floor");
    cb->tau_Tc_floor = need(co, ce, "tau_Tc_floor");
    cb->Em_peak = need(co, ce, "Em_peak");
    cb->mixing_sigma = need(co, ce, "mixing_sigma");
    cb->R_opt = need(co, ce, "R_opt");

    EdCooling *cg = &st.cooling;
    cg->regen_enabled = (uint8_t)(int)need(cc, cl, "regen_enabled");
    cg->film_enabled = (uint8_t)(int)need(cc, cl, "film_enabled");
    cg->ablative_enabled = (uint8_t)(int)need(cc, cl, "ablative_enabled");
    cg->graphite_enabled = (uint8_t)(int)need(cc, cl, "graphite_enabled");
    cg->use_cooling_coupling = (uint8_t)(int)need(cc, cl, "use_cooling_coupling");
    cg->hot_gas_viscosity = need(cc, cl, "hot_gas_viscosity");
    cg->hot_gas_thermal_conductivity = need(cc, cl, "hot_gas_thermal_conductivity");
    cg->hot_gas_cp = need(cc, cl, "hot_gas_cp");
    cg->hot_gas_prandtl = need(cc, cl, "hot_gas_prandtl");
    cg->gas_turbulence_intensity = need(cc, cl, "gas_turbulence_intensity");
    cg->recovery_factor = need(cc, cl, "recovery_factor");
    cg->radiation_emissivity_hot = need(cc, cl, "radiation_emissivity_hot");
    cg->radiation_view_factor = need(cc, cl, "radiation_view_factor");
    cg->regen_chamber_inner_diameter = need(cc, cl, "regen_chamber_inner_diameter");
    cg->ablative_coverage_fraction = need(cc, cl, "ablative_coverage_fraction");
    cg->ablative_surface_temperature_limit = need(cc, cl, "ablative_surface_temperature_limit");
    cg->ablative_material_density = need(cc, cl, "ablative_material_density");
    cg->ablative_heat_of_ablation = need(cc, cl, "ablative_heat_of_ablation");
    cg->ablative_specific_heat = need(cc, cl, "ablative_specific_heat");
    cg->ablative_pyrolysis_temperature = need(cc, cl, "ablative_pyrolysis_temperature");
    cg->ablative_use_physics_based_blowing = (uint8_t)(int)need(cc, cl, "ablative_use_physics_based_blowing");
    cg->ablative_blowing_efficiency = need(cc, cl, "ablative_blowing_efficiency");
    cg->ablative_blowing_coefficient = need(cc, cl, "ablative_blowing_coefficient");
    cg->ablative_blowing_min_reduction_factor = need(cc, cl, "ablative_blowing_min_reduction_factor");
    cg->ablative_turbulence_reference_intensity = need(cc, cl, "ablative_turbulence_reference_intensity");
    cg->ablative_turbulence_sensitivity = need(cc, cl, "ablative_turbulence_sensitivity");
    cg->ablative_turbulence_exponent = need(cc, cl, "ablative_turbulence_exponent");
    cg->ablative_turbulence_max_multiplier = need(cc, cl, "ablative_turbulence_max_multiplier");
    cg->ablative_surface_emissivity = need(cc, cl, "ablative_surface_emissivity");
    cg->ablative_ambient_temperature = need(cc, cl, "ablative_ambient_temperature");
    cg->ablative_radiative_sink_minimum_threshold = need(cc, cl, "ablative_radiative_sink_minimum_threshold");
    cg->ablative_radiative_sink_fallback_temperature = need(cc, cl, "ablative_radiative_sink_fallback_temperature");
    cg->cooling_efficiency_floor = need(cc, cl, "cooling_efficiency_floor");

    EdGeometry *gm = &st.geom;
    gm->A_throat = need(go, ge, "A_throat"); gm->A_exit = need(go, ge, "A_exit");
    gm->volume = need(go, ge, "volume"); gm->Lstar = need(go, ge, "Lstar");
    gm->length = need(go, ge, "length");
    gm->length_cylindrical = need(go, ge, "length_cylindrical");
    gm->length_contraction = need(go, ge, "length_contraction");
    gm->chamber_diameter = need(go, ge, "chamber_diameter");
    gm->exit_diameter = need(go, ge, "exit_diameter");
    gm->expansion_ratio = need(go, ge, "expansion_ratio");
    gm->nozzle_efficiency = need(go, ge, "nozzle_efficiency");

    /* iterate samples */
    const char *beg = strstr(js, "\"samples\"");
    const char *p = beg, *e;
    int n = 0;
    while (p && (p = edt_next_object(p, &e)) != NULL) {
        if (strstr(p, "_error") && strstr(p, "_error") < e) { p = e + 1; continue; }
        double Pc = need(p, e, "Pc"), mo = need(p, e, "mdot_O"), mf = need(p, e, "mdot_F");
        double MR = need(p, e, "MR"), Lstar = need(p, e, "Lstar"), Ac = need(p, e, "Ac");
        double At = need(p, e, "At"), Dinj = need(p, e, "Dinj");
        double D32_O = need(p, e, "D32_O"), D32_F = need(p, e, "D32_F");
        double u_O = need(p, e, "u_O"), u_F = need(p, e, "u_F");
        double mom_R = need(p, e, "momentum_ratio_R"), R_opt = need(p, e, "R_opt");
        double Tc = need(p, e, "Tc"), gamma = need(p, e, "gamma"), R = need(p, e, "R"), M = need(p, e, "M");
        double cstar_ideal = need(p, e, "cstar_ideal");
        double L_eff = need(p, e, "fuel_latent_heat"), Tcap = need(p, e, "fuel_T_star_cap");

        EdEtaResult eta;
        ed_status_t rc = ed_combustion_efficiency_advanced(
            cb, Lstar, Pc, Tc, cstar_ideal, gamma, R, MR, Ac, At, Dinj, mo + mf,
            u_F, u_O, D32_O, D32_F, mom_R, R_opt, L_eff, Tcap, &eta);
        if (rc != ED_OK) { fprintf(stderr, "  [FAIL] sample %d eta rc=%d\n", n, rc); g_fail++; p = e + 1; n++; continue; }

        cmp("eta_Lstar", eta.eta_Lstar, need(p, e, "eta_Lstar"));
        cmp("eta_kinetics", eta.eta_kinetics, need(p, e, "eta_kinetics"));
        cmp("eta_mixing", eta.eta_mixing, need(p, e, "eta_mixing"));
        cmp("eta_total", eta.eta_total, need(p, e, "eta_total"));

        EdCoolingResult cool;
        rc = ed_cooling_evaluate(&st, Pc, mo, mf, Tc, gamma, R, M, &cool);
        if (rc != ED_OK) { fprintf(stderr, "  [FAIL] sample %d cooling rc=%d\n", n, rc); g_fail++; p = e + 1; n++; continue; }
        cmp("cooling_eff", cool.cooling_eff, need(p, e, "cooling_eff"));
        cmp("heat_removed", cool.heat_removed, need(p, e, "heat_removed"));

        /* derived residual quantities */
        /* c* efficiency = combustion x sqrt(cooling): cooling is an energy
         * fraction, c* ~ sqrt(Tc). Mirrors ed_chamber.c and combustion_eff. */
        double eta_final = eta.eta_total * sqrt(cool.cooling_eff);
        double cstar_actual = eta_final * cstar_ideal;
        double mdot_demand = Pc * At / cstar_actual;
        cmp("eta_final", eta_final, need(p, e, "eta_final"));
        cmp("cstar_actual", cstar_actual, need(p, e, "cstar_actual"));
        cmp("mdot_demand", mdot_demand, need(p, e, "mdot_demand"));
        n++;
        p = e + 1;
    }

    free(js);
    printf("residual: %d samples, %d checks, %d failures, worst rel=%.2e\n", n, g_checked, g_fail, g_worst);
    if (n == 0) { fprintf(stderr, "FAIL: no samples\n"); return 1; }
    return g_fail ? 1 : 0;
}
