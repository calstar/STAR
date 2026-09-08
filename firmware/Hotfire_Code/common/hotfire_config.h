#pragma once

//-----------------------------------------------------------------------------
// Shared hotfire config — used by actuator_config.h and sense_config.h
// All hotfire boards (actuator, PT, TC, LC, RTD) share these.
//-----------------------------------------------------------------------------

// Heartbeat and loop
#define BOARD_HEARTBEAT_INTERVAL_MS \
    1000                  // Send board heartbeat once per second
#define LOOP_DELAY_MS 10  // Delay at end of each loop()

// USB serial: brief pause so the host monitor can attach before boot logs
// (ESP32 CDC)
#define SERIAL_MONITOR_READY_DELAY_MS 500

// Ethernet init delays (milliseconds)
#define ETHERNET_SPI_DELAY_MS 1000    // Delay after SPI.begin() for Ethernet
#define ETHERNET_INIT_DELAY_MS 1000   // Delay after Ethernet.init()
#define ETHERNET_BEGIN_DELAY_MS 1000  // Delay after Ethernet.begin()

// DHCP (opt-in per board via -DSENSOR_ETH_USE_DHCP). When enabled, the board
// tries DHCP at boot with these short timeouts, then falls back to its static
// 192.168.2.<BOARD_ID> address if no lease is obtained. Timeouts are kept
// short so a stand network without a DHCP server does not stall boot.
#ifndef SENSOR_ETH_DHCP_TIMEOUT_MS
#define SENSOR_ETH_DHCP_TIMEOUT_MS 5000  // max total wait for a DHCP lease
#endif
#ifndef SENSOR_ETH_DHCP_RESPONSE_TIMEOUT_MS
#define SENSOR_ETH_DHCP_RESPONSE_TIMEOUT_MS 2000  // per-request response wait
#endif

// Zero-config discovery (opt-in via -DSENSOR_ETH_ZEROCONF; implies DHCP).
// While no server has been heard the board broadcasts BOARD_HEARTBEAT and,
// if DHCP failed, alternates its address between static 192.168.2.<BOARD_ID>
// and a MAC-derived link-local 169.254.x.y each phase below, so both a
// production server at 192.168.2.20 and an unconfigured (self-assigned)
// laptop can find it. The server's IP is learned from its own packets.
#ifdef SENSOR_ETH_ZEROCONF
#ifndef SENSOR_ETH_USE_DHCP
#define SENSOR_ETH_USE_DHCP
#endif
#endif
// Phase dwell is 50x the server's 200 ms heartbeat period so a running
// server always locks the board long before the phase can expire.
#define SENSOR_ZEROCONF_PHASE_MS 10000
// Server silence before discovery broadcasts resume (address stays put).
#define SENSOR_ZEROCONF_SERVER_SILENCE_MS 10000

// LED status blink (optional; actuator uses, sense boards may use)
#define LED_CYCLE_MS 5000  // Cycle period for state-blink
#define LED_BLINK_ON_MS 100
#define LED_BLINK_OFF_MS 100

// Board identity
#ifndef BOARD_ID
#define BOARD_ID 21
#endif

// Safety Configuration
#ifndef ENABLE_ALL_STATE_TRANSITIONS
#define ENABLE_ALL_STATE_TRANSITIONS false
#endif

// Server (all hotfire boards send heartbeats/data here; hardcoded, not updated
// from packets)
#define HOTFIRE_SERVER_IP_OCTET_4 20  // 192.168.2.20
#define HOTFIRE_SERVER_PORT 5006

// Sensor data: chunks per packet (all sense boards: PT, TC, LC, RTD)
#define HOTFIRE_CHUNKS_PER_PACKET 9

// OTA: TCP port all hotfire boards listen on for firmware updates
#define HOTFIRE_OTA_PORT 3232
