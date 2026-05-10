#pragma once

//-----------------------------------------------------------------------------
// Shared hotfire config — used by actuator_config.h and sense_config.h
// All hotfire boards (actuator, PT, TC, LC, RTD) share these.
//-----------------------------------------------------------------------------

// Heartbeat and loop
#define BOARD_HEARTBEAT_INTERVAL_MS  1000   // Send board heartbeat once per second
#define LOOP_DELAY_MS                 10    // Delay at end of each loop()

// USB serial: brief pause so the host monitor can attach before boot logs (ESP32 CDC)
#define SERIAL_MONITOR_READY_DELAY_MS  500

// Ethernet init delays (milliseconds)
#define ETHERNET_SPI_DELAY_MS        1000   // Delay after SPI.begin() for Ethernet
#define ETHERNET_INIT_DELAY_MS       1000   // Delay after Ethernet.init()
#define ETHERNET_BEGIN_DELAY_MS     1000   // Delay after Ethernet.begin()

// LED status blink (optional; actuator uses, sense boards may use)
#define LED_CYCLE_MS                 5000   // Cycle period for state-blink
#define LED_BLINK_ON_MS              100
#define LED_BLINK_OFF_MS             100

// Board identity
#ifndef BOARD_ID
#define BOARD_ID 21
#endif


// Safety Configuration
#ifndef ENABLE_ALL_STATE_TRANSITIONS
#define ENABLE_ALL_STATE_TRANSITIONS false
#endif

// Server (all hotfire boards send heartbeats/data here; hardcoded, not updated from packets)
#define HOTFIRE_SERVER_IP_OCTET_4   20   // 192.168.2.20
#define HOTFIRE_SERVER_PORT         5006

// Sensor data: chunks per packet (all sense boards: PT, TC, LC, RTD)
#define HOTFIRE_CHUNKS_PER_PACKET   9

// OTA: TCP port all hotfire boards listen on for firmware updates
#define HOTFIRE_OTA_PORT            3232
