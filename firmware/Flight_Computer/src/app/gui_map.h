#ifndef STAR_GUI_MAP_H
#define STAR_GUI_MAP_H

/* The values the GUI shows: the rows of gui_map.c, one VALUE frame each. */

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GUI_VALUE_MAX 200U /* longest VALUE payload */

uint8_t gui_map_count(void);
/* Read every row's value now; then gui_map_value() packs them. */
void gui_map_read(void);
/* Row i's VALUE payload (PROTOCOL.md §3a) into out; returns its length. */
uint16_t gui_map_value(uint8_t i, uint8_t* out);

#ifdef __cplusplus
}
#endif
#endif
