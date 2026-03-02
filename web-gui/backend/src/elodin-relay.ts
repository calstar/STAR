/**
 * Elodin Relay — single subscriber to Elodin DB, fans out raw TABLE packets to many WebSocket clients.
 *
 * Pipeline: raw data → Elodin DB only; all services consume from DB via this relay. That keeps
 * collection invariant to upstream bugs and each service modular/independent.
 *
 * Elodin DB streams to the FIRST TCP subscriber only. This relay is that subscriber and broadcasts
 * to backend, sidecar, etc. Run before backend: npm run relay
 */

import { WebSocketServer } from 'ws';
import { ElodinClient, ElodinPacketType } from './elodin-client.js';
import { subscribeWithStream } from './elodin-stream.js';
import { registerVTables } from './elodin-vtable.js';

const ELODIN_HOST = process.env.ELODIN_HOST || '::1';
const ELODIN_PORT = parseInt(process.env.ELODIN_PORT || '2240', 10);
const RELAY_WS_PORT = parseInt(process.env.RELAY_WS_PORT || '9090', 10);
const RELAY_WS_HOST = process.env.RELAY_WS_HOST || '0.0.0.0';

function main(): void {
  const elodin = new ElodinClient(ELODIN_HOST, ELODIN_PORT);
  const wss = new WebSocketServer({ port: RELAY_WS_PORT, host: RELAY_WS_HOST });

  let clientCount = 0;
  wss.on('connection', (ws) => {
    clientCount++;
    console.log(`[Relay] Client connected (total ${clientCount})`);
    ws.on('close', () => {
      clientCount--;
      console.log(`[Relay] Client disconnected (total ${clientCount})`);
    });
    ws.on('error', () => { });
  });

  wss.on('listening', () => {
    console.log(`[Relay] WebSocket server listening on ${RELAY_WS_HOST}:${RELAY_WS_PORT}`);
    console.log(`[Relay] Backends can connect with ELODIN_RELAY_WS_URL=ws://localhost:${RELAY_WS_PORT}`);
  });

  elodin.on('packet', (header, payload) => {
    if (header.ty === ElodinPacketType.TABLE) {
      console.log(`[Relay] Received TABLE packet: packetId=[0x${header.packetId[0].toString(16)}, 0x${header.packetId[1].toString(16)}], payloadLen=${payload.length}`);
    }
    // Forward as binary: 8-byte header (len LE, ty, packetId[2], requestId) + payload
    const payloadLen = payload.length;
    const totalLen = 8 + payloadLen; // 8-byte header
    const broadcastBuffer = Buffer.alloc(totalLen);

    // 8-byte header: len(4), ty(1), packetId(2), requestId(1)
    broadcastBuffer.writeUInt32LE(totalLen - 4, 0); // total - 4
    broadcastBuffer.writeUInt8(header.ty, 4);
    broadcastBuffer.writeUInt8(header.packetId[0], 5);
    broadcastBuffer.writeUInt8(header.packetId[1], 6);
    broadcastBuffer.writeUInt8(header.requestId, 7);

    payload.copy(broadcastBuffer, 8);
    wss.clients.forEach((client) => {
      if (client.readyState === 1) client.send(broadcastBuffer);
    });
  });

  elodin.on('connected', async () => {
    console.log('[Relay] Elodin connected, subscribing...');
    await subscribeWithStream(elodin);
    await new Promise((r) => setTimeout(r, 300));
    await registerVTables(elodin);
    console.log('[Relay] Subscriptions sent; relaying TABLE packets to WebSocket clients.');
  });

  elodin.on('disconnected', () => console.log('[Relay] Elodin disconnected'));
  elodin.on('error', () => { });

  elodin.connect().then((ok) => {
    if (ok) console.log('[Relay] Connected to Elodin at ' + ELODIN_HOST + ':' + ELODIN_PORT);
    else process.exit(1);
  }).catch((e) => {
    console.error('[Relay] Elodin connection failed:', e);
    process.exit(1);
  });
}

main();
