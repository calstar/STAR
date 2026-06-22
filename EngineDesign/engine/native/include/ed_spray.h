/* ed_spray.h - Spray/mixing correlations. Port of engine/core/spray.py. */
#ifndef ED_SPRAY_H
#define ED_SPRAY_H

#include "ed_types.h"
#include "ed_state.h"

#ifdef __cplusplus
extern "C" {
#endif

double ed_momentum_flux_ratio(double rho_O, double u_O, double rho_F, double u_F);
double ed_thrust_momentum_ratio(double J, double MR);
double ed_spray_angle_from_J(double J, double k, double n);
double ed_spray_angle_from_TMR(double TMR);
double ed_weber_number(double rho, double u, double d_char, double sigma);
double ed_ohnesorge_number(double mu, double rho, double sigma, double d_or);
double ed_smd_lefebvre(double d_or, double We, double Oh, double C, double m, double p);
double ed_smd_impinging_ingebo(double d_jet, double u_rel, double rho_liq,
                               double mu_liq, double sigma, double rho_gas, double C);
double ed_tau_evap(double D32, double K);
double ed_xstar(double U_rel, double tau_evap);

/* Returns 1 if We_O>=We_min, We_F>=We_min, and (x*<x_limit or constraint off). */
int ed_check_spray_constraints(double We_O, double We_F, double x_star, const EdSpray *s);

#ifdef __cplusplus
}
#endif

#endif /* ED_SPRAY_H */
