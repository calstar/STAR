#!/usr/bin/env tsx
/**
 * UDP Listener for Actuator Command Verification
 *
 * Listens on a UDP port for actuator command packets and writes
 * received commands to a temp file for the integration test to check.
 *
 * Usage: tsx udp_listener.ts [port] [output_file] [timeout_seconds]
 *
 * DiabloAvionics actuator command format:
 *   Byte 0:    packet_type (4 = ACTUATOR_COMMAND)
 *   Byte 1:    version (0)
 *   Bytes 2-5: timestamp (uint32 LE)
 *   Byte 6:    num_actuators
 *   For each actuator:
 *     Byte N:   channel_id (uint8)
 *     Byte N+1: state (uint8, 0=CLOSED, 1=OPEN)
 */

import * as dgram from 'dgram';
import * as fs from 'fs';

const PORT = parseInt(process.argv[2] || '5005', 10);
const OUTPUT_FILE = process.argv[3] || '/tmp/udp_commands.json';
const TIMEOUT_S = parseInt(process.argv[4] || '30', 10);

interface ActuatorCommand {
  timestamp: number;
  receivedAt: number;
  packetType: number;
  version: number;
  numActuators: number;
  actuators: Array<{ channel: number; state: number }>;
  rawHex: string;
}

const commands: ActuatorCommand[] = [];

const socket = dgram.createSocket('udp4');

socket.on('message', (msg: Buffer, rinfo) => {
  const command: ActuatorCommand = {
    timestamp: 0,
    receivedAt: Date.now(),
    packetType: 0,
    version: 0,
    numActuators: 0,
    actuators: [],
    rawHex: msg.toString('hex'),
  };

  if (msg.length >= 7) {
    command.packetType = msg.readUInt8(0);
    command.version = msg.readUInt8(1);
    command.timestamp = msg.readUInt32LE(2);
    command.numActuators = msg.readUInt8(6);

    let offset = 7;
    for (let i = 0; i < command.numActuators && offset + 1 < msg.length; i++) {
      command.actuators.push({
        channel: msg.readUInt8(offset),
        state: msg.readUInt8(offset + 1),
      });
      offset += 2;
    }
  }

  commands.push(command);
  console.log(`📥 UDP packet from ${rinfo.address}:${rinfo.port} - type=${command.packetType} actuators=${JSON.stringify(command.actuators)}`);

  // Write to file after each packet
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(commands, null, 2));
});

socket.on('error', (err) => {
  console.error('❌ UDP socket error:', err);
  process.exit(1);
});

socket.bind(PORT, '0.0.0.0', () => {
  console.log(`📡 UDP listener bound to 0.0.0.0:${PORT}`);
  console.log(`   Writing commands to: ${OUTPUT_FILE}`);
  console.log(`   Timeout: ${TIMEOUT_S}s`);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(commands, null, 2));
});

// Timeout
setTimeout(() => {
  console.log(`\n⏱️ Timeout reached (${TIMEOUT_S}s). Received ${commands.length} command(s).`);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(commands, null, 2));
  socket.close();
  process.exit(0);
}, TIMEOUT_S * 1000);

// Graceful shutdown
process.on('SIGINT', () => {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(commands, null, 2));
  socket.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(commands, null, 2));
  socket.close();
  process.exit(0);
});
