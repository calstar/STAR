/**
 * Characterization: the backend's view of the Elodin schema and protocol, driven without vitest
 * and without sockets (run by elodin/run.sh via `npx tsx` from diablo_server/backend).
 *
 *   ts_registry.json  elodin-vtable-registry.ts: computeMsgId, buildVTableStreamSubscriptionList
 *                     for patched copies of config_base.toml and the default profile, an empty
 *                     config (dev fallbacks), and the bytes one registerVTables pass writes,
 *                     plus a rejection → backoff → retry pass
 *   ts_protocol.json  elodin-protocol.ts parseElodinPacket on a crafted payload for every branch
 *                     (and the too-short / non-finite / out-of-range rejections), and
 *                     elodin-client.ts framing: the bytes sendRawMessage / publishTable /
 *                     sendCommand / flushSubscriptionRequests write, and the events
 *                     handleData emits for TABLE / MSG / fence / ErrorResponse / corrupt input
 *
 * The client's socket is replaced by an in-memory recorder; nothing binds a port. Date.now is
 * pinned so sendCommand's JSON is stable.
 *
 * Usage: tsx ts_dump.mts <daq-server dir> <out dir>
 */
import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';

const [, , DAQ, OUT] = process.argv;
if (!DAQ || !OUT) {
  console.error('usage: tsx ts_dump.mts <daq-server dir> <out dir>');
  process.exit(2);
}
const BACKEND = join(DAQ, 'diablo_server', 'backend');
const require = createRequire(join(BACKEND, 'package.json'));
const { parse: parseToml } = require('smol-toml') as { parse: (s: string) => unknown };

const registry = await import(join(BACKEND, 'src', 'elodin-vtable-registry.ts'));
const protocol = await import(join(BACKEND, 'src', 'elodin-protocol.ts'));
const clientMod = await import(join(BACKEND, 'src', 'elodin-client.ts'));
const { ElodinClient, ElodinPacketType } = clientMod;

Date.now = () => 1_700_000_000_000;

const hex = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('hex').replace(/(..)(?!$)/g, '$1 ');
const h2 = (n: number): string => '0x' + n.toString(16).padStart(2, '0');
const pair = ([a, b]: [number, number]): string => `${h2(a)}/${h2(b)}`;

/** Stable JSON: numbers that are not finite become strings so NaN/Infinity survive. */
function stable(v: unknown): string {
  return JSON.stringify(
    v,
    (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : typeof x === 'bigint' ? x.toString() : x),
    2,
  ) + '\n';
}

function loadConfig(rel: string): unknown {
  const text = readFileSync(join(DAQ, rel), 'utf8').split('192.168.2.').join('127.0.0.');
  return parseToml(text);
}

/** An ElodinClient whose socket is an in-memory recorder; fence writes are answered. */
function recordingClient(): { client: any; writes: Buffer[] } {
  const client: any = new ElodinClient('127.0.0.1', 1);
  const writes: Buffer[] = [];
  client.socket = {
    write(buf: Buffer) {
      writes.push(Buffer.from(buf));
      // flushSubscriptionRequests waits for the DB's GetEarliestTimestamp reply.
      if (buf.length >= 8 && buf[5] === 0xe0 && buf[6] === 0x16) setImmediate(() => client.emit('subscriptionFence'));
      return true;
    },
    listenerCount: () => 0,
    once: () => undefined,
    destroy: () => undefined,
  };
  client._connected = true;
  return { client, writes };
}

function frame(buf: Buffer) {
  return {
    len: buf.readUInt32LE(0),
    ty: buf.readUInt8(4),
    packetId: [h2(buf[5]), h2(buf[6])],
    requestId: buf.readUInt8(7),
    payload: hex(buf.subarray(8)),
  };
}

// ── registry ─────────────────────────────────────────────────────────────────
const configs: Record<string, unknown> = {
  config_base: loadConfig('config/config_base.toml'),
  profile_default: loadConfig('config/profiles/default/config.toml'),
  empty: {},
};

const reg: Record<string, unknown> = {};
reg.computeMsgId = Object.fromEntries(
  ['VTableStream', 'VTableMsg', 'SetComponentMetadata', 'SetEntityMetadata', 'GetEarliestTimestamp', '', 'x'.repeat(40)]
    .map((n) => [n, registry.computeMsgId(n).map(h2)]),
);
reg.SUBSCRIPTION_REQ_ID_SPACE = registry.SUBSCRIPTION_REQ_ID_SPACE;
reg.MAX_PAIR_ATTEMPTS = registry.MAX_PAIR_ATTEMPTS;
reg.subscriptions = Object.fromEntries(
  Object.entries(configs).map(([name, cfg]) => {
    const list = registry.buildVTableStreamSubscriptionList(cfg) as Array<[number, number]>;
    return [name, { count: list.length, pairs: list.map(pair) }];
  }),
);

{
  // One subscription pass over config_base: the exact bytes written, then refusals of request
  // ids 3 and 250 (and of the never-assigned 255), and what the next passes send.
  let now = 1_000_000;
  registry.setClockForTests(() => now);
  registry.clearSubscriptionState();
  const { client, writes } = recordingClient();
  const r1 = await registry.registerVTables(client, configs.config_base);
  const pass1 = writes.splice(0).map((b) => hex(b));
  registry.noteSubscriptionRejected(3, 'invalid msg id');
  registry.noteSubscriptionRejected(250, 'a second refusal');
  registry.noteSubscriptionRejected(255, 'an id never assigned is ignored');
  const r2 = await registry.registerVTables(client, configs.config_base);
  const pass2 = writes.splice(0).map((b) => hex(b));
  now += 5_000;
  const r3 = await registry.registerVTables(client, configs.config_base);
  const pass3 = writes.splice(0).map((b) => hex(b));
  reg.registerVTables = {
    pass1: { result: r1, writes: pass1 },
    pass2_after_refusal_before_backoff: { result: r2, writes: pass2 },
    pass3_after_5s: { result: r3, writes: pass3 },
  };
  registry.clearSubscriptionState();
}
writeFileSync(join(OUT, 'ts_registry.json'), stable(reg));

// ── protocol: parseElodinPacket ──────────────────────────────────────────────
const TS_NS = 1_700_000_000_123_456_789n;

function raw21(ch: number, adc: number, signedAdc = false): Buffer {
  const b = Buffer.alloc(21);
  b.writeBigUInt64LE(TS_NS, 0);
  b.writeUInt8(ch, 8);
  if (signedAdc) b.writeInt32LE(adc, 12);
  else b.writeUInt32LE(adc >>> 0, 12);
  b.writeUInt32LE(0x01020304, 16);
  b.writeUInt8(1, 20);
  return b;
}
function cal21(ch: number, value: number, raw: number): Buffer {
  const b = Buffer.alloc(21);
  b.writeBigUInt64LE(TS_NS, 0);
  b.writeUInt8(ch, 8);
  b.writeFloatLE(value, 12);
  b.writeUInt32LE(raw >>> 0, 16);
  b.writeUInt8(1, 20);
  return b;
}
function state10(ch: number, st: number): Buffer {
  const b = Buffer.alloc(10);
  b.writeBigUInt64LE(TS_NS, 0);
  b.writeUInt8(ch, 8);
  b.writeUInt8(st, 9);
  return b;
}
function env24(t: number, p: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  b.writeBigUInt64LE(TS_NS, 0);
  b.writeFloatLE(t, 8);
  b.writeUInt32LE(p, 12);
  b.writeFloatLE(h, 16);
  b.writeUInt32LE(0x12345678, 20);
  return b;
}
function f64s(n: number, extra: (b: Buffer) => void, size: number): Buffer {
  const b = Buffer.alloc(size);
  b.writeBigUInt64LE(TS_NS, 0);
  for (let i = 0; i < n; i++) b.writeDoubleLE(1.25 + i, 8 + 8 * i);
  extra(b);
  return b;
}

const NEG = 0x80000005; // a code with the top bit set: signed vs unsigned reads differ
const cases: Array<[string, [number, number], Buffer, Set<number>?, Map<number, string>?]> = [
  ['ENV ok', [0x25, 25], env24(21.5, 101325, 45.25)],
  ['ENV low=0', [0x25, 0], env24(21.5, 101325, 45.25)],
  ['ENV len 23', [0x25, 25], env24(21.5, 101325, 45.25).subarray(0, 23)],
  ['ENV humidity 101', [0x25, 25], env24(21.5, 101325, 101)],
  ['ENV pressure 0', [0x25, 25], env24(21.5, 0, 50)],
  ['ENV temp NaN', [0x25, 25], env24(NaN, 1, 50)],
  ['PT1 raw CH3 signed', [0x20, 0x03], raw21(3, NEG)],
  ['PT1 raw CH3 hp slot unsigned', [0x20, 0x03], raw21(3, NEG), new Set([1])],
  ['PT2 raw CH1', [0x20, 0x21], raw21(1, 1234)],
  ['PT1 cal CH3', [0x20, 0x13], cal21(3, 412.5, NEG)],
  ['PT1 cal CH3 hp slot', [0x20, 0x13], cal21(3, 412.5, NEG), new Set([1])],
  ['PT1 cal psi -60 (rejected)', [0x20, 0x13], cal21(3, -60, 1)],
  ['PT1 cal psi 10001 (rejected)', [0x20, 0x13], cal21(3, 10001, 1)],
  ['PT1 cal NaN', [0x20, 0x13], cal21(3, NaN, 1)],
  ['PT1 raw short 20', [0x20, 0x03], raw21(3, 1).subarray(0, 20)],
  ['PT channel 0 (low 0x00)', [0x20, 0x00], raw21(0, 1)],
  ['PT channel 11 (low 0x0b)', [0x20, 0x0b], raw21(11, 1)],
  ['PT board 8 CH10 (low 0xea)', [0x20, 0xea], raw21(10, 7)],
  ['TC1 raw CH2', [0x21, 0x02], raw21(2, NEG)],
  ['TC1 cal CH2', [0x21, 0x12], cal21(2, 25.5, 99)],
  ['TC1 cal -501 (rejected)', [0x21, 0x12], cal21(2, -501, 99)],
  ['RTD1 raw CH1', [0x22, 0x01], raw21(1, NEG)],
  ['RTD1 cal CH1', [0x22, 0x11], cal21(1, -183.0, 4321)],
  ['LC2 raw CH6', [0x23, 0x26], raw21(6, NEG)],
  ['LC2 cal CH6', [0x23, 0x36], cal21(6, 12.25, 77)],
  ['LC cal force 50001 (rejected)', [0x23, 0x36], cal21(6, 50001, 77)],
  ['ENC1 raw CH1', [0x24, 0x01], raw21(1, 2048)],
  ['ENC1 cal slot (low 0x11)', [0x24, 0x11], raw21(1, 2048)],
  ['T7 slot1 raw AIN0', [0x26, 0x00], cal21(0, 1.25, 0)],
  ['T7 slot1 raw AIN14', [0x26, 0x0e], cal21(14, -0.5, 0)],
  ['T7 slot1 cal AIN1 without map', [0x26, 0x11], cal21(1, 300, 1500)],
  ['T7 slot1 cal AIN1 pressure_psi', [0x26, 0x11], cal21(1, 300, 1500), undefined, new Map([[0x11, 'pressure_psi']])],
  ['T7 slot2 cal AIN2 temperature_c', [0x26, 0x32], cal21(2, 30, 2500), undefined, new Map([[0x32, 'temperature_c']])],
  ['T7 raw NaN', [0x26, 0x01], cal21(1, NaN, 0)],
  ['ACT2 raw CH5', [0x30, 0x25], raw21(5, 3000)],
  ['ACT2 cal CH5 (0x30 cal slot)', [0x30, 0x35], cal21(5, 1.5, 3000)],
  ['ACT2 state CH5 (0x31 raw slot)', [0x31, 0x25], state10(5, 1)],
  ['ACT2 cal current CH5 (0x31 cal slot)', [0x31, 0x35], cal21(5, 0.75, 3000)],
  ['ACT cmd B2 CH5', [0x32, 0x25], state10(5, 1)],
  ['ACT cmd short 9', [0x32, 0x25], state10(5, 1).subarray(0, 9)],
  ['BV1 raw CH1', [0x33, 0x01], raw21(1, 2000)],
  ['BV1 cal CH1', [0x34, 0x11], cal21(1, 55.5, 2000)],
  ['BV1 cal NaN', [0x34, 0x11], cal21(1, NaN, 2000)],
  ['BV1 raw on cal low (ignored)', [0x33, 0x11], raw21(1, 2000)],
  ['BV cmd B1 CH1', [0x35, 0x01], state10(1, 0)],
  ['CTRL actuation', [0x40, 0x00], (() => { const b = Buffer.alloc(19); b.writeBigUInt64LE(TS_NS, 0); b.writeFloatLE(0.25, 8); b.writeFloatLE(0.75, 12); b[16] = 1; b[17] = 0; b[18] = 1; return b; })()],
  ['CTRL actuation short 18', [0x40, 0x00], Buffer.alloc(18)],
  ['CTRL diagnostics', [0x41, 0x00], f64s(6, (b) => { b.writeInt32LE(-7, 56); b[60] = 1; b[61] = 0; }, 62)],
  ['CTRL measurement 56', [0x42, 0x00], f64s(6, () => undefined, 56)],
  ['CTRL measurement 72', [0x42, 0x00], f64s(8, () => undefined, 72)],
  ['PSM state', [0x43, 0x00], (() => { const b = Buffer.alloc(11); b.writeBigUInt64LE(TS_NS, 0); b[8] = 3; b[9] = 4; b[10] = 2; return b; })()],
  ['FIRE state', [0x44, 0x00], (() => { const b = Buffer.alloc(17); b.writeBigUInt64LE(TS_NS, 0); b[8] = 1; b.writeFloatLE(0.5, 9); b.writeFloatLE(0.6, 13); return b; })()],
  ['SEQUENCER state', [0x50, 0x00], (() => { const b = Buffer.alloc(17); b.writeBigUInt64LE(TS_NS, 0); b[8] = 16; b.writeUInt32LE(0x0001a005, 12); b[16] = 1; return b; })()],
  ['SEQUENCER state short 16', [0x50, 0x00], Buffer.alloc(16)],
  ['PSM actuator cmd 0x63', [0x50, 0x63], (() => { const b = Buffer.alloc(15); b.writeBigUInt64LE(TS_NS, 0); b[8] = 4; b[9] = 2; b.writeFloatLE(0.125, 10); b[14] = 1; return b; })()],
  ['PSM actuator cmd 0x67 (out of range)', [0x50, 0x67], Buffer.alloc(15)],
  ['SELF_TEST sensor 3 board 21', [0x63, 21], state10(3, 1)],
  ['SELF_TEST 0x6f board 255', [0x6f, 255], state10(15, 0)],
  ['heartbeat table 0x10 (unmapped)', [0x10, 21], Buffer.alloc(48)],
  ['calibration cmd 0x46 (unmapped)', [0x46, 0x00], Buffer.alloc(8)],
  ['unknown 0x99', [0x99, 0x01], Buffer.alloc(21)],
];
const parsed = cases.map(([name, id, payload, hp, t7]) => ({
  name,
  packetId: pair(id),
  payload: hex(payload),
  hpBoardNumbers: hp ? [...hp] : undefined,
  t7CalFields: t7 ? Object.fromEntries([...t7].map(([k, v]) => [h2(k), v])) : undefined,
  result: protocol.parseElodinPacket(id, payload, hp, t7),
}));
const lcLegacy = [
  { name: 'parseRawLCMessage ok', result: protocol.parseRawLCMessage(raw21(6, NEG, false), [0x23, 0x26]) },
  { name: 'parseRawLCMessage short', result: protocol.parseRawLCMessage(Buffer.alloc(20), [0x23, 0x26]) },
];

// ── protocol: client framing ─────────────────────────────────────────────────
const { client: tx, writes: txw } = recordingClient();
tx.sendRawMessage([0x11, 0x0d], ElodinPacketType.MSG, Buffer.from([0x50, 0x00]), 7);
tx.sendRawMessage([0x11, 0x0d], ElodinPacketType.MSG, Buffer.from([0x20, 0x01]), 300);
tx.publishTable([0x20, 0x01], raw21(1, 5));
tx.sendCommand('state_transition', { to: 'IDLE' });
tx.sendCommand('actuator', { id: 3, open: true });
const fence = tx.flushSubscriptionRequests();
await fence;
const sent = txw.map(frame);

function hdr(len: number, ty: number, a: number, b: number, req: number): Buffer {
  const x = Buffer.alloc(8);
  x.writeUInt32LE(len, 0);
  x[4] = ty;
  x[5] = a;
  x[6] = b;
  x[7] = req;
  return x;
}
const table = Buffer.concat([hdr(4 + 21, 1, 0x20, 0x01, 0), raw21(1, 42)]);
const msgData = Buffer.concat([hdr(4 + 10, 0, 0x32, 0x21, 0), state10(1, 1)]);
const msgChatter = Buffer.concat([hdr(4 + 3, 0, 0x47, 0xb7, 0), Buffer.from([1, 2, 3])]);
const fenceReply = Buffer.concat([hdr(4 + 8, 0, 0xe0, 0x17, 255), Buffer.alloc(8)]);
const errReply = Buffer.concat([hdr(4 + 15, 0, 0xe0, 0x1d, 9), Buffer.from([14]), Buffer.from('invalid msg id')]);
const tooShortLen = Buffer.from([0x02, 0x00, 0x00, 0x00, 1, 2, 3, 4]);
const hugeLen = Buffer.from([0xff, 0xff, 0xff, 0x7f, 1, 2, 3, 4]);
const inputs: Array<[string, Buffer]> = [
  ['TABLE raw PT', table],
  ['MSG data family 0x32', msgData],
  ['MSG registration chatter 0x47b7', msgChatter],
  ['fence reply', fenceReply],
  ['ErrorResponse', errReply],
  ['len=2 (too short) then TABLE', Buffer.concat([tooShortLen, table])],
  ['len=0x7fffffff (waits for more) then TABLE', Buffer.concat([hugeLen, table])],
  ['len=65537 complete then TABLE', Buffer.concat([hdr(65537, 1, 0x20, 0x02, 0), Buffer.alloc(65533), table])],
  ['MSG fence id with request 7 (not the fence)', Buffer.concat([hdr(4, 0, 0xe0, 0x17, 7)])],
  ['TABLE empty payload', hdr(4, 1, 0x20, 0x03, 0)],
  ['TABLE split across two chunks', table],
];
const received: unknown[] = [];
for (const [name, buf] of inputs) {
  const { client: rx } = recordingClient();
  const events: unknown[] = [];
  rx.on('packet', (h: any, p: Buffer) =>
    events.push({ event: 'packet', header: { ...h, packetId: h.packetId.map(h2) }, payload: hex(p) }));
  rx.on('dbError', (id: number, d: string) => events.push({ event: 'dbError', requestId: id, description: d }));
  rx.on('subscriptionFence', () => events.push({ event: 'subscriptionFence' }));
  if (name.startsWith('TABLE split')) {
    rx.handleData(buf.subarray(0, 10));
    await new Promise((r) => setImmediate(r));
    rx.handleData(buf.subarray(10));
  } else {
    rx.handleData(buf);
  }
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  received.push({
    name,
    input: buf.length <= 64 ? hex(buf) : `${buf.length} bytes`,
    events,
    bufferedAfter: rx.buffer.length,
  });
  rx.buffer = Buffer.alloc(0);
}

writeFileSync(
  join(OUT, 'ts_protocol.json'),
  stable({ parseElodinPacket: parsed, parseRawLCMessage: lcLegacy, clientWrites: sent, clientReceive: received }),
);
process.exit(0);
