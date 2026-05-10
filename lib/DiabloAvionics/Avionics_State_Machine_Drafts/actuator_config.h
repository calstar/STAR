#pragma once

//-----------------------------------------------------------------------------
// Timing and timeouts (all in milliseconds)
//-----------------------------------------------------------------------------
#define BOARD_HEARTBEAT_INTERVAL_MS      1000   // Send board heartbeat once per second
#define LOOP_DELAY_MS                     10   // Delay at end of each loop()
#define ETHERNET_SPI_DELAY_MS            1000   // Delay after SPI.begin() for Ethernet
#define ETHERNET_INIT_DELAY_MS           1000   // Delay after Ethernet.init()
#define ETHERNET_BEGIN_DELAY_MS          1000   // Delay after Ethernet.begin()

// Watchdog and state timeouts
#define HEARTBEAT_TIMEOUT_MS             5000   // Server heartbeat watchdog
#define CONNECTION_LOSS_GRACE_MS        10000   // Time in Connection Loss before No Connection Abort
#define NO_CONNECTION_ABORT_DONE_MS    10000   // After this in No Connection Abort -> Abort Finished
#define NO_CONN_ABORT_PT_WAIT_MS        2000   // Wait for PT data in NoConnectionAbort before PT Abort / No PT Abort
#define STANDALONE_ABORT_PT_LOSS_MS     3000   // In ConnectionLossDetected, if no PT data from config for this long -> StandaloneAbort

// LED status blink
#define LED_CYCLE_MS                     5000   // Cycle period for state-blink
#define LED_BLINK_ON_MS                   100
#define LED_BLINK_OFF_MS                  100

// Sensor streaming
#define ADC_READ_INTERVAL_MS               100   // Interval between sensor data packets

//-----------------------------------------------------------------------------
// Board identity (SPIFFS)
//-----------------------------------------------------------------------------
#define SPIFFS_BOARD_VALUE_PATH         "/value.bin"
#define BOARD_ID_DEFAULT                    1
