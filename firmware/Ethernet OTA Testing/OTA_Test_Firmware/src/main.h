#pragma once

#include <Arduino.h>
#include <Ethernet.h>
#include <SPI.h>
#include <STAR_EthernetOTA.h>

// ── Board pin definitions (from shared common/) ───────────────
// Select board type by defining PINS_ACTIVE_LAYOUT before including.
// Default is PT_Board (set in sense_board_pins.h).
// Override by adding e.g. -DPINS_ACTIVE_LAYOUT=LC_Board to build_flags.
#include "sense_board_pins.h"

using sense_board_pins::Pins;  // Access pins as Pins.ETH_MOSI, etc.

// ── Network configuration ─────────────────────────────────────
#define OTA_STATIC_IP IPAddress(192, 168, 2, 5)
#define OTA_GATEWAY IPAddress(192, 168, 2, 1)
#define OTA_SUBNET IPAddress(255, 255, 255, 0)
#define OTA_DNS IPAddress(192, 168, 2, 1)
#define OTA_TCP_PORT 3232

// ── Serial message (overridden at compile time by the uploader) ─
// STAR_OTA_TEST_MESSAGE is the library-wide name for this and is what
// ota_upload.py --message and the Test-GUI's OTA tab set, so prefer it; the
// older OTA_MESSAGE spelling still works for this project.
#ifndef OTA_MESSAGE
#define OTA_MESSAGE "Default OTA firmware -- not yet updated"
#endif

// ── Timing ────────────────────────────────────────────────────
#define PRINT_INTERVAL_MS 2000     // How often to print the message to serial
#define ETHERNET_SPI_DELAY 1000    // Delay after SPI.begin()
#define ETHERNET_INIT_DELAY 1000   // Delay after Ethernet.init()
#define ETHERNET_BEGIN_DELAY 1000  // Delay after Ethernet.begin()

// ── LED ───────────────────────────────────────────────────────
// Uses Pins.LED from sense_board_pins.h (pin 16 for PT board)

// ── OTA transfer settings ─────────────────────────────────────
// Owned by the library now; override STAR_OTA_CHUNK_SIZE / STAR_OTA_TIMEOUT_MS
// in build_flags if this board ever needs different values.
