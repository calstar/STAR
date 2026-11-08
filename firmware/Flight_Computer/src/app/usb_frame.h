#ifndef STAR_USB_FRAME_H
#define STAR_USB_FRAME_H

/*
 * USB frames to and from the GUI (Test-GUI/FlightComputer-GUI/PROTOCOL.md
 * §2): type, seq, payload, CRC-16/CCITT-FALSE, COBS, then a 0x00. No I/O,
 * so it builds on a laptop (Test-GUI's tests/usb_frame.rs checks it).
 */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define USB_FRAME_MAX 1024U /* decoded: type, seq, payload, crc */
#define USB_FRAME_WIRE_MAX (USB_FRAME_MAX + USB_FRAME_MAX / 254U + 2U)

/* Encodes into out (USB_FRAME_WIRE_MAX), 0x00 included; 0 if too long. */
size_t usb_frame_encode(uint8_t type, uint8_t seq, const uint8_t* payload,
                        uint16_t len, uint8_t* out);

/* Decodes buf (without its 0x00) in place: buf[0] type, buf[1] seq, then
 * the payload. Returns the payload length, or -1 if COBS or CRC is bad. */
int usb_frame_decode(uint8_t* buf, size_t n);

/* One VALUE row: index, count, type, value, then name, unit, labels with
 * their NULs. Returns its length; 0 if it would not fit in max. */
uint16_t usb_frame_value(uint8_t* out, uint16_t max, uint8_t index,
                         uint8_t count, uint8_t type, uint32_t value,
                         const char* name, const char* unit,
                         const char* labels);

#ifdef __cplusplus
}
#endif
#endif
