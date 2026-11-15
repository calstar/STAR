#ifndef STAR_BOARD_DFU_H
#define STAR_BOARD_DFU_H

/*
 * Firmware updates over the USB-C port, no ST-Link: the STM32H723's own ROM
 * bootloader (AN2606, STM32H72xxx/73xxx: system memory at 0x1FF09800, USB DFU
 * on OTG_HS PA11/PA12, the pins this board's USB-C uses). It lives in ROM,
 * so a bad image can never take it away.
 *
 * USB ENTER_DFU (PROTOCOL.md) calls board_dfu_enter(); the board drops off
 * USB as a serial port and comes back as "STM32 BOOTLOADER" (0483:df11).
 * `pio run -e usb -t upload` (scripts/usb_upload.py) does it all.
 */

#ifdef __cplusplus
extern "C" {
#endif

/* From a task, scheduler running: detach USB, stop everything, jump to the
 * ROM bootloader. Does not return. */
void board_dfu_enter(void);

#ifdef __cplusplus
}
#endif
#endif
