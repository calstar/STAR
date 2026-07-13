/* ed_abi.h - sizeof helpers so the ctypes shim can allocate opaque buffers for
 * the POD structs without mirroring their full (evolving) layout in Python.
 * Flat double-only result structs are mirrored directly in Python instead. */
#ifndef ED_ABI_H
#define ED_ABI_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

size_t ed_sizeof_engine_state(void);
size_t ed_sizeof_cea_tables(void);
size_t ed_sizeof_workspace(void);
size_t ed_sizeof_evaluate_result(void);
size_t ed_sizeof_stability_result(void);
size_t ed_sizeof_chamber_diagnostics(void);

#ifdef __cplusplus
}
#endif

#endif /* ED_ABI_H */
