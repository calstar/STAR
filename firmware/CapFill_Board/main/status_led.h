#pragma once

// Yellow LED (D6) on GPIO16. Same pattern as the club's hotfire boards (SensorHotfireCore):
// every 2.5 s it blinks N times, where N = board state number:
//   1 blink   waiting for server (no SENSOR_CONFIG yet)
//   2 blinks  active, streaming
//   9 blinks  standalone abort
//   10 blinks self test
// CapFill-only addition: fast continuous flicker (8 Hz) = FDC1004 not responding.
void status_led_start(void);
