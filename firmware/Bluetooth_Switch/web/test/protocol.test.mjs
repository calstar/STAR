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
  version: 1, output: true, sense: 3, flags: 7, inaOk: true, readingValid: true, restored: true,
  supply_mV: 8412, current_mA: -123, power_mW: 1035, sense_mV: 2471, uptime_s: 0x01020304, resetReason: 9,
});
assert.equal(P.resetReasonName(9), "brownout");
assert.equal(P.senseVerdict(s).level, "ok");
assert.equal(P.senseVerdict({ ...s, sense: 2 }).level, "bad");
assert.equal(P.senseVerdict({ ...s, output: false, sense: 3 }).level, "bad");
assert.equal(P.senseVerdict({ ...s, output: false, sense: 1 }).level, "ok");

const bad = new Uint8Array(bytes); bad[0] = 2;
assert.throws(() => P.decodeStatus(new DataView(bad.buffer)), /version 2/);
assert.throws(() => P.decodeStatus(new DataView(new ArrayBuffer(16))), /16 bytes/);

// UUIDs must match the firmware's.
const src = readFileSync(join(fw, "src", "ble_link.cpp"), "utf8");
for (const u of [P.SERVICE_UUID, P.OUTPUT_UUID, P.STATUS_UUID]) assert.ok(src.includes(`"${u}"`), u);
const status = readFileSync(join(fw, "include", "status.h"), "utf8");
assert.match(status, new RegExp(`STATUS_VERSION = ${P.STATUS_VERSION};`));

console.log("protocol ok");
