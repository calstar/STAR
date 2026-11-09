#ifndef STAR_BOARD_CONFIG_H
#define STAR_BOARD_CONFIG_H

/*
 * The running settings (fc_config.h) and their copy in internal flash:
 * sector 3 (0x08060000, the last 128 KB of the H723VE's 512 KB), one
 * record appended per save, the newest valid one loaded at boot.
 */

#include <stdbool.h>

#include "fc_config.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Once at boot, before the tasks that read the settings start. */
void board_config_init(void);

/* A copy of the running settings (any task). */
fc_config_t board_config_get(void);
/* The saved settings; false if flash holds none. */
bool board_config_saved(fc_config_t* out);
/* Running settings differ from the saved ones (or nothing is saved). */
bool board_config_unsaved(void);
/* Flash held no valid settings at boot: running the defaults. */
bool board_config_from_defaults(void);

/* Run these settings (already checked). They reach each chip when it next
 * starts; the radio and the Idle interval at once. */
void board_config_set(const fc_config_t* c);
/* Write the running settings to flash. erase_ok: the sector may be erased
 * if full (it stalls the CPU; Idle only). false: not written. */
bool board_config_save(bool erase_ok);

#ifdef __cplusplus
}
#endif
#endif
