/* ed_cooling.h - Cooling efficiency factor used by the chamber residual.
 *
 * Port of ChamberSolver._evaluate_cooling_models + _compute_cooling_efficiency
 * for the ablative path (the one active in the canonical configs), plus the
 * regen_cooling.estimate_hot_wall_heat_flux and ablative_cooling.compute_ablative_response
 * it calls. Film/regen/graphite contributions to cooling_eff are not active in the
 * canonical configs; when their enable flags are set the port returns
 * ED_ERR_NOT_IMPLEMENTED so callers fall back rather than silently mismatch.
 */
#ifndef ED_COOLING_H
#define ED_COOLING_H

#include "ed_types.h"
#include "ed_state.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    double cooling_eff;
    double heat_removed;   /* W (ablative cooling_power) */
    double effective_Tc;   /* K (Tc_ideal - delta_T_abl) */
    double q_total;        /* W/m^2 incident hot-wall flux */
    double wetted_area;    /* m^2 */
} EdCoolingResult;

/* Huzel combustion-gas viscosity [Pa.s]. */
double ed_gas_viscosity_huzel(double T_K, double M_kg_kmol);

/* Chamber wetted surface area [m^2] (frustum model from _get_chamber_geometry). */
double ed_chamber_wetted_area(const EdGeometry *g);

/* cooling_eff (and diagnostics) for one residual evaluation. Tc/gamma/R/M are the
 * ideal CEA values. Returns cooling_eff=1 when coupling/ablative are off. */
ed_status_t ed_cooling_evaluate(const EdEngineState *s,
                                double Pc, double mdot_O, double mdot_F,
                                double Tc, double gamma, double R, double M,
                                EdCoolingResult *out);

#ifdef __cplusplus
}
#endif

#endif /* ED_COOLING_H */
