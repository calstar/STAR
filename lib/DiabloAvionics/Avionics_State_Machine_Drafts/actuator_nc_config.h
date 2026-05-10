#pragma once

//-----------------------------------------------------------------------------
// Timing and timeouts for actuator_nc mock (milliseconds)
//-----------------------------------------------------------------------------
#define HEARTBEAT_TIMEOUT_MS          5000   // Server heartbeat timeout example
#define CONNECTION_LOSS_GRACE_MS     10000   // Time in connection loss before no-connection abort (X in original)
#define HEARTBEAT_SEND_INTERVAL_MS     100   // Delay between heartbeats in mock loops
#define MAINLOOP_POLL_INTERVAL_MS      100   // General delay in mock loops
