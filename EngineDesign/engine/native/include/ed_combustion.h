/* ed_combustion.h - Combustion efficiency (eta_c*).
 *
 * Port of combustion_eff.eta_cstar -> combustion_physics.
 * calculate_combustion_efficiency_advanced and its sub-models
 * (compute_combustion_state, calculate_eta_Lstar/gasification, residence,
 * reaction time, Damkohler, mixing, turbulence).
 */
#ifndef ED_COMBUSTION_H
#define ED_COMBUSTION_H

#include "ed_types.h"
#include "ed_state.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    double eta_total;
    double eta_Lstar;
    double eta_kinetics;
    double eta_mixing;
    double eta_turbulence;
    double Da;
    double tau_res;
    double tau_chem;
} EdEtaResult;

/* Inputs gathered by the chamber residual (advanced_params in Python). D32_O/D32_F
 * are per-stream Sauter means in metres (<=0 == absent). fuel_latent_heat is L_eff
 * and fuel_T_star_cap_K is the interface cap; cp_l/T_inj/rho_l/mu use the same
 * Python defaults (2000, 293, 800, 7e-5). Returns eta components or an error if a
 * value is non-finite (mirrors the residual returning NaN). */
ed_status_t ed_combustion_efficiency_advanced(
    const EdCombustionEff *cfg,
    double Lstar, double Pc, double Tc, double cstar_ideal,
    double gamma, double R, double MR,
    double Ac, double At, double Dinj, double m_dot_total,
    double u_fuel, double u_lox,
    double D32_O, double D32_F,
    double turbulence_intensity,
    double fuel_latent_heat,
    double fuel_T_star_cap_K,
    EdEtaResult *out);

#ifdef __cplusplus
}
#endif

#endif /* ED_COMBUSTION_H */
