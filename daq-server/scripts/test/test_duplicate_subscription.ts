#!/usr/bin/env tsx
/**
 * Duplicate VTableStream Subscription Test
 *
 * Verifies whether subscribing to the same Elodin VTable multiple times causes
 * duplicate TABLE packet delivery. Connects directly to Elodin DB (bypassing
 * the backend) to isolate the behavior.
 *
 * Expects the full integration pipeline to be running:
 *   board_simulator → daq_bridge → Elodin DB
 *
 * Usage:
 *   tsx scripts/test/test_duplicate_subscription.ts [elodin_port]
 *
 * Or run within the integration test environment:
 *   ELODIN_PORT=2241 tsx scripts/test/test_duplicate_subscription.ts
 */

import { Socket } from 'net';

const ELODIN_HOST = process.env.ELODIN_HOST || '127.0.0.1';
const ELODIN_PORT = parseInt(process.argv[2] || process.env.ELODIN_PORT || '2240', 10);

// How long to collect packets for each phase (ms)
const COLLECT_MS = 4000;
// Which VTable to test — PT raw channel 1 is reliably present
const TEST_PACKET_ID: [number, number] = [0x20, 0x01];
const TEST_LABEL = `PT.CH1 [0x${TEST_PACKET_ID[0].toString(16)}, 0x${TEST_PACKET_ID[1].toString(16)}]`;

// ── FNV-1a hash (matching db.hpp msg_id) ─────────────────────────────────────

function computeMsgId(typeName: string): [number, number] {
  const FNV_OFFSET_BASIS = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;
  let hash = FNV_OFFSET_BASIS;
  const maxLen = Math.min(typeName.length, 31);
  for (let i = 0; i < maxLen; i++) {
    hash ^= typeName.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  const upper = (hash >>> 16) & 0xFFFF;
  const lower = hash & 0xFFFF;
  const xorHash = upper ^ lower;
  return [xorHash & 0xFF, (xorHash >>> 8) & 0xFF];
}

// ── Minimal Elodin TCP client ────────────────────────────────────────────────

interface PacketInfo {
  ty: number;
  packetId: [number, number];
  payloadLen: number;
  receivedAt: number;
}

class TestElodinClient {
  private socket: Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private onPacket: ((pkt: PacketInfo) => void) | null = null;

  async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new Socket();
      this.socket.setNoDelay(true);
      const timer = setTimeout(() => {
        this.socket?.destroy();
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }, 5000);

      this.socket.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      this.socket.on('data', (data: Buffer) => this.handleData(data));
      this.socket.connect(port, host);
    });
  }

  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 8) {
      const packetLen = this.buffer.readUInt32LE(0);
      if (packetLen < 4 || packetLen > 65536) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      if (this.buffer.length < packetLen + 4) break;
      const ty = this.buffer.readUInt8(4);
      const high = this.buffer.readUInt8(5);
      const low = this.buffer.readUInt8(6);
      this.buffer = this.buffer.subarray(packetLen + 4);
      if (this.onPacket) {
        this.onPacket({ ty, packetId: [high, low], payloadLen: packetLen - 4, receivedAt: Date.now() });
      }
    }
  }

  setPacketHandler(handler: (pkt: PacketInfo) => void): void {
    this.onPacket = handler;
  }

  sendVTableStreamSubscription(packetId: [number, number]): void {
    if (!this.socket) throw new Error('Not connected');
    const vtableStreamMsgId = computeMsgId('VTableStream');
    // Payload: postcard-encoded VTableStream { id: (u8, u8) } = 2 bytes
    const payload = Buffer.alloc(2);
    payload.writeUInt8(packetId[0], 0);
    payload.writeUInt8(packetId[1], 1);
    // Header: len(4) + ty(1) + packetId(2) + requestId(1) = 8 bytes
    const header = Buffer.alloc(8);
    header.writeUInt32LE(payload.length + 4, 0); // len = payload + 4 (ty+id+reqId)
    header.writeUInt8(0, 4); // ty = MSG (0)
    header.writeUInt8(vtableStreamMsgId[0], 5);
    header.writeUInt8(vtableStreamMsgId[1], 6);
    header.writeUInt8(0, 7); // requestId
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function collectPackets(
  client: TestElodinClient,
  targetId: [number, number],
  durationMs: number,
): Promise<PacketInfo[]> {
  return new Promise((resolve) => {
    const collected: PacketInfo[] = [];
    client.setPacketHandler((pkt) => {
      if (pkt.ty === 1 && pkt.packetId[0] === targetId[0] && pkt.packetId[1] === targetId[1]) {
        collected.push(pkt);
      }
    });
    setTimeout(() => {
      client.setPacketHandler(() => {});
      resolve(collected);
    }, durationMs);
  });
}

// ── Main test ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🧪 Duplicate VTableStream Subscription Test');
  console.log(`   Elodin: ${ELODIN_HOST}:${ELODIN_PORT}`);
  console.log(`   Target: ${TEST_LABEL}`);
  console.log(`   Collect window: ${COLLECT_MS / 1000}s per phase`);
  console.log('');

  const client = new TestElodinClient();

  try {
    await client.connect(ELODIN_HOST, ELODIN_PORT);
    console.log('✅ Connected to Elodin DB');
  } catch (err: any) {
    console.error(`❌ Failed to connect to Elodin: ${err.message}`);
    console.error('   Is the integration pipeline running? (elodin-db + daq_bridge + board_simulator)');
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  // ── Phase 1: Subscribe once, measure baseline rate ─────────────────────────
  console.log('\n📊 Phase 1: Single subscription (baseline)');
  client.sendVTableStreamSubscription(TEST_PACKET_ID);
  // Small delay for subscription to take effect
  await new Promise((r) => setTimeout(r, 500));

  const baseline = await collectPackets(client, TEST_PACKET_ID, COLLECT_MS);
  const baselineRate = baseline.length / (COLLECT_MS / 1000);
  console.log(`   Received ${baseline.length} packets in ${COLLECT_MS / 1000}s (${baselineRate.toFixed(1)} pkt/s)`);

  if (baseline.length === 0) {
    console.error('❌ No packets received — VTable may not be registered or no data flowing.');
    console.error('   Ensure daq_bridge and board_simulator are running.');
    client.close();
    process.exit(1);
  }

  console.log(`   ✅ Baseline: ${baselineRate.toFixed(1)} pkt/s`);

  // ── Phase 2: Subscribe again (duplicate), measure rate ─────────────────────
  console.log('\n📊 Phase 2: Duplicate subscription (subscribe again to same VTable)');
  client.sendVTableStreamSubscription(TEST_PACKET_ID);
  await new Promise((r) => setTimeout(r, 500));

  const afterDup1 = await collectPackets(client, TEST_PACKET_ID, COLLECT_MS);
  const dup1Rate = afterDup1.length / (COLLECT_MS / 1000);
  console.log(`   Received ${afterDup1.length} packets in ${COLLECT_MS / 1000}s (${dup1Rate.toFixed(1)} pkt/s)`);

  // ── Phase 3: Subscribe 3 more times, measure rate ──────────────────────────
  console.log('\n📊 Phase 3: 3 more duplicate subscriptions (5 total)');
  client.sendVTableStreamSubscription(TEST_PACKET_ID);
  client.sendVTableStreamSubscription(TEST_PACKET_ID);
  client.sendVTableStreamSubscription(TEST_PACKET_ID);
  await new Promise((r) => setTimeout(r, 500));

  const afterDup5 = await collectPackets(client, TEST_PACKET_ID, COLLECT_MS);
  const dup5Rate = afterDup5.length / (COLLECT_MS / 1000);
  console.log(`   Received ${afterDup5.length} packets in ${COLLECT_MS / 1000}s (${dup5Rate.toFixed(1)} pkt/s)`);

  // ── Analyze results ────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Results');
  console.log('═══════════════════════════════════════════════════════════');

  console.log(`\n  Rates:  baseline=${baselineRate.toFixed(1)}  after-2x=${dup1Rate.toFixed(1)}  after-5x=${dup5Rate.toFixed(1)} pkt/s`);

  // Allow 20% tolerance for timing jitter
  const tolerance = 0.20;

  // Check: rate after 2 subscriptions should not be ~2x baseline
  const ratio2x = dup1Rate / baselineRate;
  if (ratio2x < 1 + tolerance) {
    console.log(`  ✅ 2 subscriptions: no duplication (ratio=${ratio2x.toFixed(2)}x, expected ~1.0x)`);
    passed++;
  } else if (ratio2x >= 2 - tolerance) {
    console.log(`  ❌ 2 subscriptions: DUPLICATES DETECTED (ratio=${ratio2x.toFixed(2)}x, ~2x baseline)`);
    failed++;
  } else {
    console.log(`  ⚠️  2 subscriptions: ambiguous (ratio=${ratio2x.toFixed(2)}x)`);
    failed++;
  }

  // Check: rate after 5 subscriptions should not be ~5x baseline
  const ratio5x = dup5Rate / baselineRate;
  if (ratio5x < 1 + tolerance) {
    console.log(`  ✅ 5 subscriptions: no duplication (ratio=${ratio5x.toFixed(2)}x, expected ~1.0x)`);
    passed++;
  } else if (ratio5x >= 2 - tolerance) {
    console.log(`  ❌ 5 subscriptions: DUPLICATES DETECTED (ratio=${ratio5x.toFixed(2)}x — ${ratio5x >= 4.5 ? '~5x' : ratio5x >= 1.5 ? `~${Math.round(ratio5x)}x` : '???'} baseline)`);
    failed++;
  } else {
    console.log(`  ⚠️  5 subscriptions: ambiguous (ratio=${ratio5x.toFixed(2)}x)`);
    failed++;
  }

  // Check for exact duplicate timestamps (strongest signal)
  console.log('\n  Checking for duplicate timestamps within collection windows...');
  for (const [label, packets] of [['after-2x', afterDup1], ['after-5x', afterDup5]] as const) {
    const timestamps = packets.map((p) => p.receivedAt);
    // Group by ~1ms buckets and look for bursts
    const buckets = new Map<number, number>();
    for (const t of timestamps) {
      const bucket = Math.floor(t);
      buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
    }
    const maxBurst = Math.max(...buckets.values(), 0);
    const avgPerMs = packets.length / COLLECT_MS;
    // If max burst is significantly higher than average, duplicates are likely
    if (maxBurst > 1 && maxBurst > avgPerMs * 10) {
      console.log(`  ⚠️  ${label}: max burst of ${maxBurst} packets in 1ms (avg ${avgPerMs.toFixed(2)}/ms) — possible duplicates`);
    } else {
      console.log(`  ✅ ${label}: max burst ${maxBurst} packets/ms (avg ${avgPerMs.toFixed(2)}/ms) — looks normal`);
    }
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);

  client.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ Unhandled error:', err);
  process.exit(1);
});
