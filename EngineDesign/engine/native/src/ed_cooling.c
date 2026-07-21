/* ed_cooling.c - ablative cooling_eff, faithful port of the chamber cooling path.
 *
 * Chain: _get_chamber_geometry (wetted area) -> gas state + Huzel viscosity ->
 * estimate_hot_wall_heat_flux -> compute_ablative_response -> effective_Tc ->
 * _compute_cooling_efficiency. Matches Python expression-for-expression.
 */
#include "ed_cooling.h"
#include "ed_phys_const.h"

#include <math.h>
#include <string.h>

double ed_gas_viscosity_huzel(double T_K, double M) {
    const double T_rankine = T_K * ED_RANKINE_PER_KELVIN;
    const double mu_lb_per_in_s = ED_HUZEL_COEFF * sqrt(M) * pow(T_rankine, 0.6);
    return mu_lb_per_in_s * ED_LB_PER_IN_S_TO_PA_S;
}

double ed_chamber_wetted_area(const EdGeometry *g) {
    double diameter = g->chamber_diameter;
    if (diameter <= 0) diameter = 0.08;     /* matches Python final fallback */
    if (diameter < 1e-6) diameter = 1e-6;
    const double area_cross = ED_PI * (diameter * 0.5) * (diameter * 0.5);
    const double circumference = ED_PI * diameter;

    /* Frustum model when both sub-lengths are present (canonical), else cylinder. */
    if (g->length_cylindrical > 0 && g->length_contraction > 0) {
        const double area_cyl = circumference * g->length_cylindrical;
        const double r1 = diameter * 0.5;
        const double A_throat = (g->A_throat > 0) ? g->A_throat : area_cross / 3.0;
        const double r2 = sqrt(A_throat / ED_PI);
        const double slant = sqrt((r1 - r2) * (r1 - r2) + g->length_contraction * g->length_contraction);
        return area_cyl + ED_PI * (r1 + r2) * slant;
    }
    return circumference * g->length;
}

/* estimate_hot_wall_heat_flux -> {q_total, q_conv, q_rad}. */
static void hot_wall_flux(const EdEngineState *s, double Pc, double Tc, double gamma,
                          double R, double M, double mdot_total, double wall_T,
                          double *q_total, double *q_conv, double *q_rad) {
    const EdCooling *c = &s->cooling;
    const double d = c->regen_chamber_inner_diameter; /* config.chamber_inner_diameter */
    const double A_cross = ED_PI * d * d / 4.0;
    const double rho_g = ed_max(Pc / (R * ed_max(Tc, 1.0)), ED_MIN_DENS_KG_M3);
    const double V_g = mdot_total / (rho_g * A_cross);

    const double mu_g = (M > 0 && Tc > 0) ? ed_gas_viscosity_huzel(Tc, M) : c->hot_gas_viscosity;
    const double k_g = c->hot_gas_thermal_conductivity;
    const double cp_g = gamma * R / ed_max(gamma - 1.0, ED_EPS_SMALL);
    const double Pr_g = (c->hot_gas_prandtl > 0) ? c->hot_gas_prandtl : (mu_g * cp_g / ed_max(k_g, ED_EPS_SMALL));

    const double Re_g = rho_g * V_g * d / ed_max(mu_g, ED_EPS_TINY);
    const double Nu_g = (Re_g < 2000.0) ? ED_NU_LAMINAR
                        : ED_NU_TURB_COEF * pow(Re_g, ED_NU_TURB_RE_EXP) * pow(Pr_g, ED_NU_TURB_PR_EXP);
    const double h_g = Nu_g * k_g / d;

    const double Taw = Tc * c->recovery_factor;
    const double dT = ed_max(Taw - wall_T, 0.0);
    *q_conv = h_g * dT;
    double qr = c->radiation_emissivity_hot * c->radiation_view_factor * ED_STEFAN_BOLTZMANN
                * (Tc * Tc * Tc * Tc - wall_T * wall_T * wall_T * wall_T);
    *q_rad = ed_max(qr, 0.0);
    *q_total = *q_conv + *q_rad;
}

/* compute_ablative_response -> heat_removed (cooling_power). */
static double ablative_heat_removed(const EdCooling *c, double surface_T, double area,
                                    double ti, double q_conv, double q_rad,
                                    double gas_mdot) {
    if (!c->ablative_enabled || area <= 0) return 0.0;

    double turb = 1.0;
    if (ti > 0 && c->ablative_turbulence_reference_intensity > 0) {
        const double ratio = pow(ti / c->ablative_turbulence_reference_intensity,
                                 c->ablative_turbulence_exponent);
        turb = 1.0 + c->ablative_turbulence_sensitivity * ratio;
    }
    turb = ed_clip(turb, 1.0, c->ablative_turbulence_max_multiplier);

    const int below_pyro = surface_T < c->ablative_pyrolysis_temperature;
    int use_physics = 0;
    double convective_reduction = 1.0;
    if (below_pyro) {
        convective_reduction = 1.0;
    } else if (c->ablative_use_physics_based_blowing && gas_mdot > 0) {
        use_physics = 1;
    } else {
        convective_reduction = 1.0 - ed_clip(c->ablative_blowing_efficiency, 0.0, 1.0);
    }

    const double T_sink = (c->ablative_ambient_temperature < c->ablative_radiative_sink_minimum_threshold)
                          ? c->ablative_radiative_sink_fallback_temperature
                          : c->ablative_ambient_temperature;
    double radiative_relief = c->ablative_surface_emissivity * ED_STEFAN_BOLTZMANN
                              * (surface_T * surface_T * surface_T * surface_T
                                 - T_sink * T_sink * T_sink * T_sink);
    radiative_relief = ed_max(radiative_relief, 0.0);

    const double q_conv_incident = q_conv, q_rad_incident = q_rad;

    if (use_physics) {
        const double q_conv_prov = q_conv_incident * turb;
        const double q_total_prov = ed_max(q_conv_prov + q_rad_incident - radiative_relief, 0.0);
        if (q_total_prov > 0) {
            const double dT_pyro = ed_max(surface_T - c->ablative_pyrolysis_temperature, 0.0);
            const double energy_per_mass = c->ablative_heat_of_ablation + c->ablative_specific_heat * dT_pyro;
            if (energy_per_mass > 0) {
                const double mass_flux_prov = q_total_prov / ed_max(energy_per_mass, ED_EPS_SMALL);
                const double m_dot_pyro = mass_flux_prov * area;
                const double B = m_dot_pyro / ed_max(gas_mdot, ED_EPS_SMALL);
                const double blow = 1.0 / (1.0 + c->ablative_blowing_coefficient * B);
                convective_reduction = ed_max(blow, c->ablative_blowing_min_reduction_factor);
            } else {
                convective_reduction = 1.0;
            }
        } else {
            convective_reduction = 1.0;
        }
    }

    const double q_conv_eff = q_conv_incident * turb * convective_reduction;
    const double effective_heat_flux = ed_max(q_conv_eff + q_rad_incident - radiative_relief, 0.0);

    if (below_pyro || effective_heat_flux <= 0) return 0.0;
    const double dT_pyro = ed_max(surface_T - c->ablative_pyrolysis_temperature, 0.0);
    const double energy_per_mass = c->ablative_heat_of_ablation + c->ablative_specific_heat * dT_pyro;
    if (energy_per_mass <= 0) return 0.0;
    return effective_heat_flux * area; /* cooling_power == heat_removed */
}

ed_status_t ed_cooling_evaluate(const EdEngineState *s,
                                double Pc, double mdot_O, double mdot_F,
                                double Tc, double gamma, double R, double M,
                                EdCoolingResult *out) {
    if (!s || !out) return ED_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));
    out->cooling_eff = 1.0;
    out->effective_Tc = Tc;

    const double mdot_total = mdot_O + mdot_F;
    if (mdot_total <= 0) return ED_OK;

    const EdCooling *c = &s->cooling;
    /* Film/regen/graphite contributions to cooling_eff aren't active in the
     * canonical configs; refuse rather than silently mismatch if enabled. */
    if (c->film_enabled || c->regen_enabled) return ED_ERR_NOT_IMPLEMENTED;
    if (!c->use_cooling_coupling || !c->ablative_enabled) return ED_OK;

    const EdGeometry *g = &s->geom;
    double diameter = g->chamber_diameter;
    if (diameter <= 0) diameter = 0.08;
    if (diameter < 1e-6) diameter = 1e-6;
    const double area_cross = ED_PI * (diameter * 0.5) * (diameter * 0.5);
    const double rho_g = ed_max(Pc / (R * ed_max(Tc, 1.0)), 1e-6);
    const double velocity_g = mdot_total / (rho_g * area_cross);

    const double mu_g = (M > 0 && Tc > 0) ? ed_gas_viscosity_huzel(Tc, M) : c->hot_gas_viscosity;
    const double Re_g = rho_g * velocity_g * diameter / ed_max(mu_g, 1e-8);

    double ti = 0.05;
    if (Re_g > 0) ti = ed_clip(0.16 * pow(Re_g, -0.125), 0.02, 0.25);
    ti = ed_max(ti, ed_clip(c->gas_turbulence_intensity, 0.0, 0.5));

    /* hot-wall flux uses Tc_ideal (film disabled => effective_Tc == Tc here) */
    double q_total, q_conv, q_rad;
    hot_wall_flux(s, Pc, Tc, gamma, R, M, mdot_total,
                  c->ablative_surface_temperature_limit, &q_total, &q_conv, &q_rad);

    const double abl_area = ed_chamber_wetted_area(g) * ed_clip(c->ablative_coverage_fraction, 0.0, 1.0);
    const double heat_removed = ablative_heat_removed(c, c->ablative_surface_temperature_limit,
                                                      abl_area, ti, q_conv, q_rad, mdot_total);

    /* effective_Tc reduction (feeds the cooling_eff denominator only) */
    double effective_Tc = Tc;
    const double cp = gamma * R / ed_max(gamma - 1.0, ED_EPS_SMALL);
    if (heat_removed > 0 && mdot_total > 0) {
        const double delta_T = heat_removed / ed_max(mdot_total * cp, ED_EPS_SMALL);
        effective_Tc = ed_max(effective_Tc - delta_T, 1.0);
    }

    /* _compute_cooling_efficiency */
    double cooling_eff = 1.0;
    if (heat_removed > 0) {
        const double available = mdot_total * cp * ed_max(effective_Tc, 1.0);
        if (available > 0) {
            const double factor = 1.0 - heat_removed / available;
            cooling_eff = ed_clip(factor, c->cooling_efficiency_floor, 1.0);
        }
    }

    out->cooling_eff = cooling_eff;
    out->heat_removed = heat_removed;
    out->effective_Tc = effective_Tc;
    out->q_total = q_total;
    out->wetted_area = abl_area;
    return ED_OK;
}
