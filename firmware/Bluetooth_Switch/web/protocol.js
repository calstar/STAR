// BLE contract with the firmware. Keep in step with src/ble_link.cpp and
// include/status.h; test/protocol.test.mjs checks the layout against the C struct.

export const SERVICE_UUID = "53544152-0001-4b8a-9d3e-7a1c2f6b0e10";
export const OUTPUT_UUID = "53544152-0002-4b8a-9d3e-7a1c2f6b0e10";
export const STATUS_UUID = "53544152-0003-4b8a-9d3e-7a1c2f6b0e10";
export const FIRMWARE_UUID = "53544152-0004-4b8a-9d3e-7a1c2f6b0e10";  // 32-byte image SHA-256, read-only
export const NAME_PREFIX = "STAR-Switch";

export const STATUS_VERSION = 1;
export const STATUS_LENGTH = 17;

export const SENSE = ["unknown", "load present", "open", "live"];

export const FLAG_INA_OK = 1 << 0;
export const FLAG_READING_VALID = 1 << 1;
export const FLAG_RESTORED = 1 << 2;

// esp_reset_reason_t
const RESET_REASONS = [
  "unknown", "power-on", "external pin", "software", "panic", "interrupt watchdog",
  "task watchdog", "other watchdog", "deep sleep", "brownout", "SDIO", "USB",
  "JTAG", "eFuse", "power glitch", "CPU lockup",
];
export const resetReasonName = (r) => RESET_REASONS[r] ?? `reason ${r}`;

// CI writes a record per image to the firmware-registry branch, keyed on the
// digest the board reports (.github/workflows/firmware-ci.yml).
export const REGISTRY_BOARD = "Bluetooth_Switch";
export const registryUrl = (digestHex) =>
  `https://raw.githubusercontent.com/calstar/STAR/firmware-registry/${REGISTRY_BOARD}/${digestHex}.json`;

// DataView -> lowercase hex, the way the registry names files.
export function digestHex(dv) {
  if (dv.byteLength !== 32) throw new Error(`firmware hash is ${dv.byteLength} bytes, expected 32`);
  let s = "";
  for (let i = 0; i < 32; i++) s += dv.getUint8(i).toString(16).padStart(2, "0");
  return s;
}

// DataView -> status object, or throws on a packet this page can't read.
export function decodeStatus(dv) {
  if (dv.byteLength < STATUS_LENGTH) throw new Error(`status packet is ${dv.byteLength} bytes, expected ${STATUS_LENGTH}`);
  const version = dv.getUint8(0);
  if (version !== STATUS_VERSION) throw new Error(`status version ${version}; this page reads ${STATUS_VERSION}`);
  const flags = dv.getUint8(3);
  return {
    version,
    output: dv.getUint8(1) === 1,
    sense: dv.getUint8(2),
    flags,
    inaOk: !!(flags & FLAG_INA_OK),
    readingValid: !!(flags & FLAG_READING_VALID),
    restored: !!(flags & FLAG_RESTORED),
    supply_mV: dv.getUint16(4, true),
    current_mA: dv.getInt16(6, true),
    power_mW: dv.getUint16(8, true),
    sense_mV: dv.getUint16(10, true),
    uptime_s: dv.getUint32(12, true),
    resetReason: dv.getUint8(16),
  };
}

// What the sense line says about the output, given what the output should be.
// Returns {level: "ok" | "warn" | "bad", text}.
export function senseVerdict(s) {
  const name = SENSE[s.sense] ?? `sense ${s.sense}`;
  if (s.sense === 0) return { level: "warn", text: "Sense settling" };
  if (s.output) {
    return s.sense === 3
      ? { level: "ok", text: "Armed: altimeter power live" }
      : { level: "bad", text: `ARMED but sense reads ${name}: altimeters may be unpowered (switch or supply fault)` };
  }
  if (s.sense === 1) return { level: "ok", text: "Altimeter connected" };
  if (s.sense === 2) return { level: "warn", text: "Nothing connected (open)" };
  return { level: "bad", text: "DISARMED but altimeter power is live: switch stuck or back-fed" };
}
