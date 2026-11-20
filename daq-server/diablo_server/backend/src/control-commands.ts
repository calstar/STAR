/**
 * Commands that move hardware, so need an approved operator with control unlocked
 * (server.ts handleCommand enforces it server-side, whatever the UI shows).
 * 'switch' arms or disarms a Bluetooth altimeter switch.
 */
export const CONTROL_COMMAND_TYPES: ReadonlySet<string> = new Set([
  'state_transition', 'actuator', 'extend_fire', 'debug_mode',
  'session_start', 'session_stop', 'session_extend', 'switch',
]);
