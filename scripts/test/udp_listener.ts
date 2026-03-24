#!/usr/bin/env tsx
/**
 * UDP listener for integration: actuator commands (type 4), SERVER_HEARTBEAT (type 2), etc.
 *
 * Usage: tsx udp_listener.ts [port] [output_file] [timeout_seconds]
 *
 * Type 4 ACTUATOR_COMMAND (DiabloAvionics):
 *   Byte 0: packet_type (4)
 *   Byte 1: version
 *   Bytes 2-5: timestamp (uint32 LE)
 *   Byte 6: num_actuators
 *   Then pairs: channel_id, state
 *
 * Type 2 SERVER_HEARTBEAT (daq_bridge):
 *   Byte 0: 2
 *   Byte 1: version
 *   Bytes 2-5: timestamp_ms (uint32 LE)
 *   Byte 6: engine_state
 */

import * as dgram from 'dgram';
import * as fs from 'fs';

const PORT = parseInt(process.argv[2] || '5005', 10);
const OUTPUT_FILE = process.argv[3] || '/tmp/udp_commands.json';
const TIMEOUT_S = parseInt(process.argv[4] || '30', 10);

const PACKET_ACTUATOR_COMMAND = 4;
const PACKET_SERVER_HEARTBEAT = 2;

interface UdpRecord {
  receivedAt: number;
  packetType: number;
  rawHex: string;
  version: number;
  /** uint32 LE from wire (actuator cmd or server heartbeat) */
  timestamp: number;
  numActuators: number;
  actuators: Array<{ channel: number; state: number }>;
  /** Present when packetType === SERVER_HEARTBEAT */
  engineState?: number;
}

function parseMessage(msg: Buffer): UdpRecord {
  const base: UdpRecord = {
    receivedAt: Date.now(),
    packetType: msg.length > 0 ? msg.readUInt8(0) : 0,
    rawHex: msg.toString('hex'),
    version: 0,
    timestamp: 0,
    numActuators: 0,
    actuators: [],
  };

  if (msg.length < 2) return base;

  base.packetType = msg.readUInt8(0);
  base.version = msg.readUInt8(1);

  if (base.packetType === PACKET_SERVER_HEARTBEAT && msg.length >= 7) {
    base.timestamp = msg.readUInt32LE(2);
    base.engineState = msg.readUInt8(6);
    return base;
  }

  if (base.packetType === PACKET_ACTUATOR_COMMAND && msg.length >= 7) {
    base.timestamp = msg.readUInt32LE(2);
    base.numActuators = msg.readUInt8(6);
    let offset = 7;
    for (let i = 0; i < base.numActuators && offset + 1 < msg.length; i++) {
      base.actuators.push({
        channel: msg.readUInt8(offset),
        state: msg.readUInt8(offset + 1),
      });
      offset += 2;
    }
    return base;
  }

  if (msg.length >= 6) {
    base.timestamp = msg.readUInt32LE(2);
  }
  return base;
}

const packets: UdpRecord[] = [];

const socket = dgram.createSocket('udp4');

socket.on('message', (msg: Buffer, rinfo) => {
  const rec = parseMessage(msg);
  packets.push(rec);
  const extra =
    rec.packetType === PACKET_SERVER_HEARTBEAT
      ? `engineState=${rec.engineState ?? 'n/a'}`
      : `actuators=${JSON.stringify(rec.actuators)}`;
  console.log(`📥 UDP from ${rinfo.address}:${rinfo.port} type=${rec.packetType} ${extra}`);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(packets, null, 2));
});

socket.on('error', (err) => {
  console.error('❌ UDP socket error:', err);
  process.exit(1);
});

socket.bind(PORT, '0.0.0.0', () => {
  console.log(`📡 UDP listener bound to 0.0.0.0:${PORT}`);
  console.log(`   Writing packets to: ${OUTPUT_FILE}`);
  console.log(`   Timeout: ${TIMEOUT_S}s`);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(packets, null, 2));
});

setTimeout(() => {
  console.log(`\n⏱️ Timeout reached (${TIMEOUT_S}s). Received ${packets.length} packet(s).`);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(packets, null, 2));
  socket.close();
  process.exit(0);
}, TIMEOUT_S * 1000);

process.on('SIGINT', () => {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(packets, null, 2));
  socket.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(packets, null, 2));
  socket.close();
  process.exit(0);
});
