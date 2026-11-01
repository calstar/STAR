// Frame building for the FPGA's SPI protocol. Pure functions, no I/O:
// tested on the host and against the RTL (gateware/tb/test_io.py).
#pragma once
#include <stddef.h>
#include <stdint.h>

// Each returns the frame length in bytes.
size_t fpga_frame_write(uint8_t *buf, unsigned addr, uint32_t val);  // 5 bytes
size_t fpga_frame_read(uint8_t *buf, unsigned addr);                  // 6 bytes
size_t fpga_frame_ts(uint8_t *buf, const uint8_t *pkts, size_t n);    // 1 + 188 n bytes

// The register value from the MISO bytes of a read frame.
uint32_t fpga_parse_read(const uint8_t *rx);
