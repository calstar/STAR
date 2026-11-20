/**
 * What a Bluetooth switch's status means, from the fields daq_bridge logs (SW<role>.*).
 *
 * A port of senseVerdict in firmware/Bluetooth_Switch/web/protocol.js. Both run the cases in
 * lib/daq-protocol/test/switch_verdicts.json, so the DAQ and the switch's own web page cannot
 * disagree about a status. Change the rules there first.
 */

export type VerdictLevel = 'ok' | 'warn' | 'bad';
export interface Verdict { level: VerdictLevel; text: string }

/** The StatusPacket fields the verdict reads (lib/daq-protocol/src/SwitchStatus.h). */
export interface SwitchStatusFields {
  output: number;  // 0 off, 1 on
  sense: number;   // 0 unknown, 1 load present, 2 open, 3 live
  flags: number;   // bit0 INA ok, bit1 reading valid, bit2 restored, bit3 no battery
}

export const FLAG_INA_OK = 1 << 0;
export const FLAG_READING_VALID = 1 << 1;
export const FLAG_RESTORED = 1 << 2;
export const FLAG_NO_BATTERY = 1 << 3;
export const STATUS_VERSION = 1;
export const STATUS_LENGTH = 17;

export function switchVerdict(s: SwitchStatusFields): Verdict {
  if (s.flags & FLAG_NO_BATTERY) {
    return s.output
      ? { level: 'bad', text: 'Armed, but no battery is connected, so the load has no power.' }
      : { level: 'warn', text: 'No battery connected' };
  }
  if (s.sense === 0) return { level: 'warn', text: 'Sense settling' };
  if (s.output) {
    return s.sense === 3
      ? { level: 'ok', text: 'Armed: output live' }
      : { level: 'bad', text: "Armed, but no power is reaching the output. Check the battery; if it's fine, the switch may be faulty." };
  }
  // Disarmed continuity can't see through the bridge board, so load and open both read as plain disarmed.
  if (s.sense !== 3) return { level: 'ok', text: 'Disarmed' };
  return { level: 'bad', text: 'Disarmed, but the output still has power. The switch may be stuck on.' };
}

/** Raw StatusPacket bytes -> fields. The DAQ gets fields from Elodin; this is for the shared cases. */
export function decodeSwitchStatus(bytes: Uint8Array): SwitchStatusFields {
  if (bytes.length < STATUS_LENGTH) throw new Error(`status packet is ${bytes.length} bytes, expected ${STATUS_LENGTH}`);
  if (bytes[0] !== STATUS_VERSION) throw new Error(`status version ${bytes[0]}; this page reads ${STATUS_VERSION}`);
  return { output: bytes[1], sense: bytes[2], flags: bytes[3] };
}

// esp_reset_reason_t
const RESET_REASONS = [
  'unknown', 'power-on', 'external pin', 'software', 'panic', 'interrupt watchdog',
  'task watchdog', 'other watchdog', 'deep sleep', 'brownout', 'SDIO', 'USB',
  'JTAG', 'eFuse', 'power glitch', 'CPU lockup',
];
export const resetReasonName = (r: number): string => RESET_REASONS[r] ?? `reason ${r}`;
