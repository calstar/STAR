/* ed_workspace.c - Workspace lifecycle. The struct is POD and stack-allocatable;
 * this TU exists so callers can take the address of a reset routine and to host
 * any future non-inline workspace helpers. */
#include "ed_workspace.h"

/* Out-of-line mirror of ed_workspace_reset for ABI/ctypes consumers. */
void ed_workspace_init(EdWorkspace *ws) {
    ed_workspace_reset(ws);
}
