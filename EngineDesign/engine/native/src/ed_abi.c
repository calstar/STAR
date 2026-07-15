/* ed_abi.c - struct sizes for the ctypes shim (offline/setup only). */
#include "ed_abi.h"
#include "ed_state.h"
#include "ed_cea.h"
#include "ed_workspace.h"
#include "ed_evaluate.h"
#include "ed_stability.h"
#include "ed_chamber.h"

size_t ed_sizeof_engine_state(void)       { return sizeof(EdEngineState); }
size_t ed_sizeof_cea_tables(void)         { return sizeof(EdCeaTables); }
size_t ed_sizeof_workspace(void)          { return sizeof(EdWorkspace); }
size_t ed_sizeof_evaluate_result(void)    { return sizeof(EdEvaluateResult); }
size_t ed_sizeof_stability_result(void)   { return sizeof(EdStabilityResult); }
size_t ed_sizeof_chamber_diagnostics(void){ return sizeof(EdChamberDiagnostics); }
