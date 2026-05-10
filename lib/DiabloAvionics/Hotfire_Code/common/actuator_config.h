#pragma once

#include "hotfire_config.h"

//-----------------------------------------------------------------------------
// Actuator hotfire — timing and timeouts (milliseconds)
//-----------------------------------------------------------------------------

// Watchdog and state timeouts
#define HEARTBEAT_TIMEOUT_MS             5000   // Server heartbeat watchdog
#define CONNECTION_LOSS_GRACE_MS         10000   // Time in Connection Loss before No Connection Abort
#define NO_CONNECTION_ABORT_DONE_MS      10000   // Legacy; No Connection Abort -> Abort Finished
#define NO_CONN_ABORT_PT_WAIT_MS         2000   // Wait for PT data in NoConnectionAbort before PT Abort / No PT Abort

// Abort procedure timeouts
#define PT_ABORT_THRESHOLD_TIMEOUT_MS    10000   // PT Abort: max wait for PTs below threshold before applying abort
#define NO_PT_ABORT_VENT_TO_ABORT_MS     10000   // No PT Abort: wait between vent and abort
#define STANDALONE_ABORT_VENT_TO_ABORT_MS 10000  // Standalone Abort: wait between vent and abort (local only)
#define STANDALONE_ABORT_PT_LOSS_MS      3000   // ConnectionLossDetected: no PT data from config for this long -> StandaloneAbort

// Board identity (SPIFFS)
#define SPIFFS_BOARD_VALUE_PATH         "/value.bin"
#define BOARD_ID_DEFAULT                1

// Actuator current-sense streaming
#define ADC_READ_INTERVAL_MS             100    // Interval between sensor data packets
