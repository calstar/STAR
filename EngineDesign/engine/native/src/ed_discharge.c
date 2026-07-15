/* ed_discharge.c - Port of discharge.py (Cd models). */
#include "ed_discharge.h"

double ed_cd_inf_from_orifice_diameter(double d_hyd_m, const EdDischarge *c) {
    if (!c) return NAN;
    if (!c->use_geometry_cd) return c->Cd_inf;
    if (!(isfinite(d_hyd_m)) || d_hyd_m <= 0.0) return c->Cd_inf;

    const double d_min = c->d_min_m;
    const double d_ref = c->d_ref_m;
    const double cd_base = c->Cd_inf;
    const double exp_small = c->cd_small_hole_exponent;
    const double log_gain = c->cd_large_hole_log_gain;
    const double cd_max = c->cd_inf_max;
    const double cd_floor = c->cd_inf_min_geom;

    const double d = ed_max(d_min, d_hyd_m);
    if (d_ref <= 0.0) return ed_clip(cd_base, cd_floor, cd_max);

    const double ratio = d / d_ref;
    double cd_geom;
    if (ratio < 1.0) {
        cd_geom = cd_base * pow(ratio, ed_max(0.0, exp_small));
    } else {
        cd_geom = cd_base + log_gain * log(ratio);
    }
    return ed_clip(cd_geom, cd_floor, cd_max);
}

double ed_cd_from_re(double Re, const EdDischarge *c,
                     double P_inlet, double T_inlet, double d_hyd_m) {
    if (!c) return NAN;
    const double cd_inf_eff = ed_cd_inf_from_orifice_diameter(d_hyd_m, c);

    if (Re <= 0.0) return c->Cd_min;

    double Cd = cd_inf_eff - c->a_Re / sqrt(ed_max(Re, 1e-6));

    if (c->use_pressure_correction && isfinite(P_inlet) && c->P_ref > 0.0) {
        Cd *= 1.0 + c->a_P * (P_inlet / c->P_ref - 1.0);
    }
    if (c->use_temperature_correction && isfinite(T_inlet) && c->T_ref > 0.0) {
        Cd *= 1.0 + c->a_T * (T_inlet / c->T_ref - 1.0);
    }

    return ed_clip(Cd, c->Cd_min, cd_inf_eff);
}

double ed_reynolds(double rho, double u, double d_hyd, double mu) {
    if (mu <= 0.0) return 1e6;
    return (rho * u * d_hyd) / mu;
}
