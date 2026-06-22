/* ed_evaluate.c - Module 2 entry point (chamber solve -> nozzle -> Isp/thrust).
 * Gated on the chamber/nozzle ports; see README.md "Staged plan". */
#include "ed_evaluate.h"
#include "ed_chamber.h"
#include <string.h>

ed_status_t ed_evaluate(const EdEngineState *state,
                        const EdCeaTables *cea,
                        double P_tank_O_Pa,
                        double P_tank_F_Pa,
                        double P_ambient_Pa,
                        double Pc_guess_Pa,
                        EdWorkspace *ws,
                        EdEvaluateResult *out) {
    (void)P_ambient_Pa;
    if (!out) return ED_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));

    EdChamberDiagnostics ch;
    ed_status_t rc = ed_chamber_solve(state, cea, P_tank_O_Pa, P_tank_F_Pa,
                                      Pc_guess_Pa, ws, &ch);
    if (rc != ED_OK) return rc; /* propagates ED_ERR_NOT_IMPLEMENTED today */

    /* Nozzle expansion + thrust/Isp assembly lands with the chamber port. */
    return ED_ERR_NOT_IMPLEMENTED;
}

ed_status_t ed_evaluate_batch(const EdEngineState *state,
                              const EdCeaTables *cea,
                              size_t n,
                              const double *P_tank_O_Pa,
                              const double *P_tank_F_Pa,
                              double P_ambient_Pa,
                              EdWorkspace *ws,
                              EdEvaluateResult *out) {
    if (!P_tank_O_Pa || !P_tank_F_Pa || !out) return ED_ERR_INVALID_ARG;
    ed_status_t last = ED_OK;
    for (size_t i = 0; i < n; ++i) {
        last = ed_evaluate(state, cea, P_tank_O_Pa[i], P_tank_F_Pa[i],
                           P_ambient_Pa, 0.0, ws, &out[i]);
    }
    return last;
}
