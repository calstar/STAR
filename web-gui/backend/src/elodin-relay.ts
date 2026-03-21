/**
 * Elodin Relay — single subscriber to Elodin DB, fans out raw TABLE packets to many WebSocket clients
 * and optionally to a TCP port for C++ calibration_service.
 *
 * Pipeline: raw data → Elodin DB only; all services consume from DB via this relay. That keeps
 * collection invariant to upstream bugs and each service modular/independent.
 *
 * Elodin DB streams to the FIRST TCP subscriber only. This relay is that subscriber and broadcasts
 * to backend, sidecar, calibration_service. Run before backend: npm run relay
 */

import * as net from 'net';
import { WebSocketServer } from 'ws';
import { ElodinClient, ElodinPacketType } from './elodin-client.js';
import { registerVTables } from './elodin-vtable.js';
import { registerControllerVTables, registerActuatorCommandedVTables } from './elodin-vtable-controller.js';
import { loadActuatorChannelToEntityMap } from './sensor-config.js';

const ELODIN_HOST = process.env.ELODIN_HOST || '127.0.0.1';
const ELODIN_PORT = parseInt(process.env.ELODIN_PORT || '2240', 10);
const RELAY_WS_PORT = parseInt(process.env.RELAY_WS_PORT || '9090', 10);
const RELAY_WS_HOST = process.env.RELAY_WS_HOST || '0.0.0.0';
const RELAY_TCP_FORWARD_PORT = parseInt(process.env.RELAY_TCP_FORWARD_PORT || '9091', 10);

function main(): void {
  const elodin = new ElodinClient(ELODIN_HOST, ELODIN_PORT);
  const wss = new WebSocketServer({ port: RELAY_WS_PORT, host: RELAY_WS_HOST });

  let clientCount = 0;
  wss.on('connection', (ws) => {
    clientCount++;
    console.log(`[Relay] Client connected (total ${clientCount})`);
    ws.on('message', (data: Buffer | string) => {
      if (typeof data !== 'string') return;
      try {
        const msg = JSON.parse(data) as { type?: string; packetId?: number[]; payload?: string };
        if (msg.type === 'publish' && Array.isArray(msg.packetId) && msg.packetId.length === 2 && typeof msg.payload === 'string') {
          const payload = Buffer.from(msg.payload, 'base64');
          if (elodin.isConnected()) {
            const ok = elodin.publishTable([msg.packetId[0], msg.packetId[1]], payload);
            console.log(`[Relay] Publish [0x${(msg.packetId[0] as number).toString(16)},0x${(msg.packetId[1] as number).toString(16)}] → Elodin: ${ok ? 'OK' : 'FAIL'}`);
          } else {
            console.warn('[Relay] Publish dropped: Elodin not connected');
          }
        }
      } catch (_) { /* ignore malformed */ }
    });
    ws.on('close', () => {
      clientCount--;
      console.log(`[Relay] Client disconnected (total ${clientCount})`);
    });
    ws.on('error', () => { });
  });

  wss.on('listening', () => {
    console.log(`[Relay] WebSocket server listening on ${RELAY_WS_HOST}:${RELAY_WS_PORT}`);
    console.log(`[Relay] Backends can connect with ELODIN_RELAY_WS_URL=ws://localhost:${RELAY_WS_PORT}`);
    if (RELAY_DEBUG_HEARTBEAT) {
      console.log('[Relay] RELAY_DEBUG_HEARTBEAT=1 — will log each heartbeat (0x10) packet');
    }
  });

  // TCP forward for C++ calibration_service (same packet format as WebSocket)
  const tcpClients: net.Socket[] = [];
  const tcpServer = net.createServer((sock) => {
    tcpClients.push(sock);
    console.log(`[Relay] TCP client connected (calibration_service) (total ${tcpClients.length})`);
    sock.on('close', () => {
      const idx = tcpClients.indexOf(sock);
      if (idx >= 0) tcpClients.splice(idx, 1);
    });
    sock.on('error', () => { });
  });
  tcpServer.listen(RELAY_TCP_FORWARD_PORT, '127.0.0.1', () => {
    console.log(`[Relay] TCP forward listening on 127.0.0.1:${RELAY_TCP_FORWARD_PORT} (calibration_service)`);
  });

  let tablePacketCount = 0;
  let heartbeatPacketCount = 0;
  let resubscribeTimer: NodeJS.Timeout | null = null;
  const MAX_RESUBSCRIBE_ATTEMPTS = parseInt(process.env.RELAY_MAX_RESUBSCRIBE_ATTEMPTS || '24', 10);
  const RELAY_DEBUG_HEARTBEAT = process.env.RELAY_DEBUG_HEARTBEAT === '1';
  // Track which high-byte packet ID groups have delivered at least one TABLE packet.
  // Groups: 0x10=heartbeat, 0x20=PT, 0x21=TC, 0x22=RTD, 0x23=LC, 0x30=ACT, 0x31=ACT_STATE, 0x40=CTRL_ACT, 0x41=CTRL_DIAG, 0x42=CTRL_MEAS
  const seenHighBytes = new Set<number>();

  // Re-send VTableStream subscriptions. Elodin DB rejects subscriptions for
  // VTables that aren't registered yet, so retry until all expected groups flow.
  // daq_bridge VTables register in ~2s; controller VTables register a few seconds later.
  function scheduleResubscribe(attempt: number): void {
    if (attempt > MAX_RESUBSCRIBE_ATTEMPTS) {
      console.warn(`[Relay] Reached max resubscribe attempts (${MAX_RESUBSCRIBE_ATTEMPTS}); keeping current subscriptions.`);
      return;
    }
    if (resubscribeTimer) return;
    resubscribeTimer = setTimeout(() => {
      resubscribeTimer = null;
      if (!elodin.isConnected()) return;
      const missingGroups = [0x10, 0x20, 0x21, 0x22, 0x23, 0x24, 0x30, 0x31, 0x40, 0x41, 0x42, 0x60]
        .filter(g => !seenHighBytes.has(g));
      if (missingGroups.length > 0) {
        const missing = missingGroups.map(g => `0x${g.toString(16)}`).join(', ');
        console.log(`[Relay] Missing groups [${missing}] — retrying subscriptions (attempt #${attempt})...`);
        registerVTables(elodin).then(() => {
          scheduleResubscribe(attempt + 1);
        }).catch((e) => {
          console.error('[Relay] Subscription retry failed:', e);
          scheduleResubscribe(attempt + 1);
        });
      }
    }, 5000);
  }

  elodin.on('packet', (header, payload) => {
    if (header.ty === ElodinPacketType.TABLE) {
      tablePacketCount++;
      seenHighBytes.add(header.packetId[0]);
      if (header.packetId[0] === 0x10) {
        heartbeatPacketCount++;
        if (RELAY_DEBUG_HEARTBEAT) {
          console.log(`[Relay] Heartbeat #${heartbeatPacketCount} board_id=${header.packetId[1]} payloadLen=${payload.length}`);
        }
      }
      // Cancel retry once all expected groups are delivering data
      if (resubscribeTimer) {
        const allGroups = [0x10, 0x20, 0x21, 0x22, 0x23, 0x24, 0x30, 0x31, 0x40, 0x41, 0x42, 0x60];
        if (allGroups.every(g => seenHighBytes.has(g))) {
          clearTimeout(resubscribeTimer);
          resubscribeTimer = null;
        }
      }
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
      if (client.readyState === 1) {
        try { client.send(broadcastBuffer); } catch (_) { /* ignore closed client */ }
      }
    });
    tcpClients.forEach((sock) => {
      if (sock.writable) {
        try { sock.write(broadcastBuffer); } catch (_) { /* ignore */ }
      }
    });
  });

  elodin.on('connected', () => {
    console.log('[Relay] Elodin connected, registering VTables and sending subscriptions...');
    tablePacketCount = 0;
    seenHighBytes.clear();
    if (resubscribeTimer) { clearTimeout(resubscribeTimer); resubscribeTimer = null; }
    // Register CONTROLLER VTables so publish [0x43] from backend→relay→Elodin is accepted
    registerControllerVTables(elodin).then((ok) => {
      if (ok) console.log('[Relay] Controller VTables registered (CONTROLLER.state etc.)');
    }).catch((e) => { console.error('[Relay] Controller VTable registration failed:', e); });
    const actuatorMap = loadActuatorChannelToEntityMap();
    registerActuatorCommandedVTables(elodin, actuatorMap).then((ok) => {
      if (ok) console.log('[Relay] Actuator Commanded VTables registered');
    }).catch((e) => { console.error('[Relay] Actuator Commanded VTable registration failed:', e); });
    // Use VTableStream (not Stream) so Elodin DB sends whole-row TABLE packets
    registerVTables(elodin).then(() => {
      console.log('[Relay] VTableStream subscriptions sent; relaying TABLE packets to WebSocket clients.');
      scheduleResubscribe(2);
    }).catch((e) => {
      console.error('[Relay] Initial subscription failed:', e);
      scheduleResubscribe(1);
    });
  });

  elodin.on('disconnected', () => {
    console.log('[Relay] Elodin disconnected');
    tablePacketCount = 0;
    heartbeatPacketCount = 0;
    seenHighBytes.clear();
    if (resubscribeTimer) { clearTimeout(resubscribeTimer); resubscribeTimer = null; }
  });
  elodin.on('error', () => { });

  // Periodic diagnostic: if we get TABLE packets but no heartbeats, daq_bridge may not be publishing
  setInterval(() => {
    if (tablePacketCount > 100 && heartbeatPacketCount === 0 && !seenHighBytes.has(0x10)) {
      console.warn(`[Relay] ⚠️ Received ${tablePacketCount} TABLE packets but 0 heartbeats (0x10) — is daq_bridge receiving UDP from boards and publishing to Elodin?`);
    }
  }, 15000);

  process.on('uncaughtException', (err) => {
    console.error('[Relay] Uncaught exception (keeping alive):', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[Relay] Unhandled rejection (keeping alive):', reason);
  });

  const CONNECT_RETRY_BASE_MS = 2000;
  const CONNECT_RETRY_MAX_MS = 30000;
  let connectAttempt = 0;

  function connectWithRetry(): void {
    connectAttempt++;
    elodin.connect().then((ok) => {
      if (ok) {
        connectAttempt = 0;
        console.log('[Relay] Connected to Elodin at ' + ELODIN_HOST + ':' + ELODIN_PORT);
      } else {
        const delay = Math.min(CONNECT_RETRY_BASE_MS * 2 ** (connectAttempt - 1), CONNECT_RETRY_MAX_MS);
        console.warn(`[Relay] Elodin connect attempt #${connectAttempt} returned false — retrying in ${delay}ms`);
        setTimeout(connectWithRetry, delay);
      }
    }).catch((e) => {
      const delay = Math.min(CONNECT_RETRY_BASE_MS * 2 ** (connectAttempt - 1), CONNECT_RETRY_MAX_MS);
      console.error(`[Relay] Elodin connection failed (attempt #${connectAttempt}) — retrying in ${delay}ms:`, e);
      setTimeout(connectWithRetry, delay);
    });
  }

  connectWithRetry();
}

main();
