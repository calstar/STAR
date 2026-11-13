// node web/test/protocol.test.mjs  (needs a host C++ compiler)
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as P from "../protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const fw = join(here, "..", "..");
const exe = join(mkdtempSync(join(tmpdir(), "sw-")), "pack");
execFileSync("c++", ["-std=c++17", "-I", join(fw, "include"), join(here, "pack_status.cpp"), "-o", exe]);
const bytes = execFileSync(exe);
assert.equal(bytes.length, P.STATUS_LENGTH);

const s = P.decodeStatus(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
assert.deepEqual(s, {
  version: 1, output: true, sense: 3, flags: 15, inaOk: true, readingValid: true, restored: true,
  noBattery: true, supply_mV: 8412, current_mA: -123, power_mW: 1035, sense_mV: 2471,
  uptime_s: 0x01020304, resetReason: 9,
});
assert.equal(P.resetReasonName(9), "brownout");
assert.equal(P.senseVerdict(s).level, "bad");  // armed with no battery
assert.equal(P.senseVerdict({ ...s, output: false }).level, "warn");
assert.match(P.senseVerdict({ ...s, output: false, sense: 1 }).text, /No battery/);  // beats "connected"
s.noBattery = false;
assert.equal(P.senseVerdict(s).level, "ok");
assert.equal(P.senseVerdict({ ...s, sense: 2 }).level, "bad");
assert.equal(P.senseVerdict({ ...s, output: false, sense: 3 }).level, "bad");
assert.equal(P.senseVerdict({ ...s, output: false, sense: 1 }).text, "Disarmed");
assert.equal(P.senseVerdict({ ...s, output: false, sense: 2 }).text, "Disarmed");  // no load is not a warning

const bad = new Uint8Array(bytes); bad[0] = 2;
assert.throws(() => P.decodeStatus(new DataView(bad.buffer)), /version 2/);
assert.throws(() => P.decodeStatus(new DataView(new ArrayBuffer(16))), /16 bytes/);

// UUIDs must match the firmware's.
const src = readFileSync(join(fw, "src", "ble_link.cpp"), "utf8");
for (const u of [P.SERVICE_UUID, P.OUTPUT_UUID, P.STATUS_UUID, P.FIRMWARE_UUID]) assert.ok(src.includes(`"${u}"`), u);
const status = readFileSync(join(fw, "include", "status.h"), "utf8");
assert.match(status, new RegExp(`STATUS_VERSION = ${P.STATUS_VERSION};`));

// Firmware hash: raw bytes -> the registry's lowercase file name.
const h = new Uint8Array(32).map((_, i) => i * 8 + 1);
assert.equal(P.digestHex(new DataView(h.buffer)), Array.from(h, (b) => b.toString(16).padStart(2, "0")).join(""));
assert.match(P.digestHex(new DataView(h.buffer)), /^[0-9a-f]{64}$/);
assert.throws(() => P.digestHex(new DataView(new ArrayBuffer(31))), /31 bytes/);
assert.ok(P.registryUrl("ab").endsWith("/firmware-registry/Bluetooth_Switch/ab.json"));
// The board name must match the one CI records it under.
const ci = readFileSync(join(fw, "..", "..", ".github", "workflows", "firmware-ci.yml"), "utf8");
assert.match(ci, new RegExp(`board: ${P.REGISTRY_BOARD},\\s+project: Bluetooth_Switch`));

console.log("protocol ok");
