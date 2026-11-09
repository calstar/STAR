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
/* A radio frame heard (radio_task_on_frame, receiver role): queued and
 * sent to the laptop as RADIO_RX. Radio task; never blocks (drops if full). */
void usb_link_radio_rx(uint8_t type, uint16_t seq, const uint8_t* payload,
                       uint8_t len, int16_t rssi_x2, int16_t snr_x4);

#ifdef __cplusplus
}
#endif
#endif
