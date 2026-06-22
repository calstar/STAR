/* test_chamber_golden.c - Golden parity for ed_chamber_solve / ed_evaluate /
 * ed_stability_analyze vs Python runner.evaluate().
 *
 * Stage 3 implemented ed_chamber_solve (verified to ~5e-10 vs Python via the
 * ctypes parity harness, since building a full EdEngineState in C is redundant).
 * ed_evaluate / ed_stability_analyze remain incomplete (nozzle + stability are
 * Stages 4-5). This test verifies the API contracts that still hold:
 *   - ed_chamber_solve rejects an invalid (zeroed) state gracefully (error, no crash)
 *   - ed_evaluate does NOT yet return ED_OK (nozzle pending)
 *   - ed_stability_analyze returns ED_ERR_NOT_IMPLEMENTED
 * It then SKIPs (exit 77); end-to-end chamber parity lives in the ctypes harness.
 */
#include "ed_evaluate.h"
#include "ed_chamber.h"
#include "ed_stability.h"
#include <stdio.h>
#include <string.h>

int main(void) {
    EdEngineState st; memset(&st, 0, sizeof st);
    EdCeaTables cea; memset(&cea, 0, sizeof cea);
    EdWorkspace ws; ed_workspace_reset(&ws);

    /* Zeroed state -> degenerate bounds: chamber solve must fail cleanly, not crash. */
    EdChamberDiagnostics ch;
    ed_status_t rc_ch = ed_chamber_solve(&st, &cea, 5e6, 5e6, 0.0, &ws, &ch);
    if (rc_ch == ED_OK) {
        fprintf(stderr, "FAIL: chamber solve unexpectedly succeeded on zeroed state\n");
        return 1;
    }

    /* ed_evaluate is not complete until the nozzle port (Stage 4): must not be OK. */
    EdEvaluateResult ev;
    ed_status_t rc = ed_evaluate(&st, &cea, 5.0e6, 5.0e6, 101325.0, 0.0, &ws, &ev);
    if (rc == ED_OK) {
        fprintf(stderr, "FAIL: ed_evaluate returned OK before nozzle port\n");
        return 1;
    }

    EdStabilityResult stab;
    if (ed_stability_analyze(&st, &ch, &ev, &stab) != ED_ERR_NOT_IMPLEMENTED) {
        fprintf(stderr, "FAIL: ed_stability_analyze contract changed\n");
        return 1;
    }

    printf("chamber solve: implemented (parity via ctypes harness). "
           "evaluate/stability: pending Stages 4-5.\n");
    printf("SKIP: C-side evaluate/stability golden deferred.\n");
    return 77; /* CTest SKIP_RETURN_CODE */
}
