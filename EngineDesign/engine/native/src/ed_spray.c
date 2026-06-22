/* ed_spray.c - Port of engine/core/spray.py (formulas used by the impinging solve).
 * Each function mirrors its Python counterpart including degenerate-input returns. */
#include "ed_spray.h"

double ed_momentum_flux_ratio(double rho_O, double u_O, double rho_F, double u_F) {
    if (u_F == 0.0) return (u_O > 0.0) ? INFINITY : 0.0;
    return (rho_O * u_O * u_O) / (rho_F * u_F * u_F);
}

double ed_thrust_momentum_ratio(double J, double MR) {
    return (MR > 0.0) ? J / (1.0 + MR) : J;
}

double ed_spray_angle_from_J(double J, double k, double n) {
    if (J <= 0.0) return 0.0;
    double theta = 2.0 * atan(k * pow(J, n));
    return ed_clip(theta, 0.0, ED_PI / 2.0);
}

double ed_spray_angle_from_TMR(double TMR) {
    if (TMR <= 0.0) return 0.0;
    double cos_theta = 1.0 / (1.0 + pow(TMR, 0.75));
    cos_theta = ed_clip(cos_theta, -1.0, 1.0);
    return acos(cos_theta);
}

double ed_weber_number(double rho, double u, double d_char, double sigma) {
    if (sigma <= 0.0) return INFINITY;
    return (rho * u * u * d_char) / sigma;
}

double ed_ohnesorge_number(double mu, double rho, double sigma, double d_or) {
    if (rho <= 0.0 || sigma <= 0.0 || d_or <= 0.0) return 0.0;
    double sqrt_arg = rho * sigma * d_or;
    return (sqrt_arg > 0.0) ? mu / sqrt(ed_max(sqrt_arg, 1e-12)) : 0.0;
}

double ed_smd_lefebvre(double d_or, double We, double Oh, double C, double m, double p) {
    if (We <= 0.0 || d_or <= 0.0) return d_or;
    return C * d_or * pow(We, -m) * pow(1.0 + Oh, p);
}

double ed_smd_impinging_ingebo(double d_jet, double u_rel, double rho_liq,
                               double mu_liq, double sigma, double rho_gas, double C) {
    if (d_jet <= 0.0 || u_rel <= 0.0 || sigma <= 0.0 || rho_gas <= 0.0 ||
        rho_liq <= 0.0 || mu_liq <= 0.0 || C <= 0.0) {
        return d_jet;
    }
    double We_g = rho_gas * u_rel * u_rel * d_jet / sigma;
    double Re_l = rho_liq * u_rel * d_jet / mu_liq;
    double product = We_g * Re_l;
    if (product <= 0.0) return d_jet;
    return C * d_jet * pow(product, -0.25);
}

double ed_tau_evap(double D32, double K) { return K * D32 * D32; }

double ed_xstar(double U_rel, double tau_evap) { return U_rel * tau_evap; }

int ed_check_spray_constraints(double We_O, double We_F, double x_star, const EdSpray *s) {
    if (We_O < s->we_min) return 0;
    if (We_F < s->we_min) return 0;
    if (s->evap_use_constraint && x_star >= s->evap_x_star_limit) return 0;
    return 1;
}
