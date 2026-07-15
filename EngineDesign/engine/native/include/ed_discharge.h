/* ed_discharge.h - Injector discharge coefficient model. Port of discharge.py. */
#ifndef ED_DISCHARGE_H
#define ED_DISCHARGE_H

#include "ed_types.h"
#include "ed_state.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Geometry-based asymptotic Cd at high Re (cd_inf_from_orifice_diameter).
 * Returns config Cd_inf when use_geometry_cd is false or d_hyd invalid. */
double ed_cd_inf_from_orifice_diameter(double d_hyd_m, const EdDischarge *c);

/* Cd(Re) = Cd_inf,eff - a_Re/sqrt(Re), with optional P/T corrections, clamped
 * to [Cd_min, Cd_inf,eff]. Pass NAN for P_inlet/T_inlet to skip a correction.
 * Port of discharge.cd_from_re. */
double ed_cd_from_re(double Re, const EdDischarge *c,
                     double P_inlet, double T_inlet, double d_hyd_m);

/* Re = rho*u*d_hyd/mu (calculate_reynolds_number; returns 1e6 if mu<=0). */
double ed_reynolds(double rho, double u, double d_hyd, double mu);

#ifdef __cplusplus
}
#endif

#endif /* ED_DISCHARGE_H */
