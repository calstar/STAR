#ifndef STAR_USB_LINK_H
#define STAR_USB_LINK_H

/*
 * The GUI's USB link (Test-GUI/FlightComputer-GUI/PROTOCOL.md): COBS frames
 * in over CDC; HELLO, GET_STATUS and SET_STREAM answered, the rest
 * NOT_IMPLEMENTED; gui_map.c's rows once a second and SAMPLEs at the
 * stream rate out, only while a program holds the port open (DTR).
 */

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void usb_link_rx(const uint8_t* bytes, uint32_t len); /* USB interrupt */
void usb_link_run(void); /* the USB task's loop; never returns */
uint16_t usb_link_rate_hz(void);

#ifdef __cplusplus
}
#endif
#endif
