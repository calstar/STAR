/* ed_feed_loss.h - Feed-system pressure loss. Port of feed_loss.delta_p_feed. */
#ifndef ED_FEED_LOSS_H
#define ED_FEED_LOSS_H

#include "ed_types.h"
#include "ed_state.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Delta_p_feed = K_eff(P) * (rho/2) * (mdot/(rho*A))^2, clamped to >= 0.
 * A = pi*(d_inlet/2)^2 when d_inlet>0, else A_hydraulic. Returns NAN on invalid
 * geometry/inputs (the Python version raises; callers treat NAN as failure). */
double ed_delta_p_feed(double mdot, double rho, const EdFeed *cfg, double P_tank);

#ifdef __cplusplus
}
#endif

#endif /* ED_FEED_LOSS_H */
