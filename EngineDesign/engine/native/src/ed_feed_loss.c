/* ed_feed_loss.c - Port of feed_loss.delta_p_feed (engine/pipeline/feed_loss.py).
 *
 * Delta_p = K_eff(P) * (rho/2) * v^2, v = mdot/(rho*A), clamped to >= 0.
 * Where Python raises ValueError (bad area/rho/mdot), this returns NAN so the
 * caller can treat the design point as invalid (matches residual NaN handling).
 */
#include "ed_feed_loss.h"

double ed_delta_p_feed(double mdot, double rho, const EdFeed *cfg, double P_tank) {
    if (!cfg) return NAN;

    double K_eff;
    switch (cfg->phi_type) {
        case ED_PHI_NONE:  K_eff = cfg->K0; break;
        case ED_PHI_SQRTP: K_eff = cfg->K0 + cfg->K1 * sqrt(ed_max(0.0, P_tank)); break;
        case ED_PHI_LOGP:  K_eff = cfg->K0 + cfg->K1 * log(P_tank); break;
        default: return NAN;
    }

    double A;
    if (cfg->d_inlet > 0.0) {
        A = ED_PI * (cfg->d_inlet * 0.5) * (cfg->d_inlet * 0.5);
    } else {
        A = cfg->A_hydraulic;
    }

    if (!(A > 0.0) || !(rho > 0.0) || mdot < 0.0) return NAN;

    const double v = mdot / (rho * A);
    double dp = K_eff * (rho * 0.5) * v * v;
    if (dp < 0.0) dp = 0.0;
    return dp;
}
