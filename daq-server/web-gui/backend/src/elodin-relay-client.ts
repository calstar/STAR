/**
 * Client that connects to the Elodin Relay WebSocket and emits 'packet' events
 * in the same format as ElodinClient — so the backend can use it as a drop-in
 * for receiving streamed data without opening a direct connection to Elodin.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { ElodinPacketType, ElodinPacketHeader } from './elodin-client.js';

export class ElodinRelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private _connected: boolean = false;
  private buffer: Buffer = Buffer.alloc(0);

  get connected(): boolean {
    return this._connected;
  }

  constructor(relayWsUrl: string) {
    super();
    this.url = relayWsUrl;
  }

  connect(): Promise<boolean> {
    if (this._connected) return Promise.resolve(true);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
    return new Promise((resolve) => {
      try {
        const ws = new WebSocket(this.url, { handshakeTimeout: 5000 });
        this.ws = ws;
        ws.binaryType = 'arraybuffer';
        ws.on('open', () => {
          this._connected = true;
          this.emit('connected');
          resolve(true);
        });
        ws.on('message', (data: Buffer | ArrayBuffer) => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          this.buffer = Buffer.concat([this.buffer, buf]);
          this.drainPackets();
        });
        ws.on('close', (code, reason) => {
          if (this.ws === ws) {
            this._connected = false;
            this.ws = null;
            this.emit('disconnected');
            resolve(false);
          }
        });
        ws.on('error', (err) => {
          this.emit('error', err);
          resolve(false);
        });
      } catch (e) {
        this.emit('error', e);
        resolve(false);
      }
    });
  }

  private static readonly MAX_BUFFER_BYTES = 2 * 1024 * 1024;

  private drainPackets(): void {
    if (this.buffer.length > ElodinRelayClient.MAX_BUFFER_BYTES) {
      console.error(`[RelayClient] ⚠️ Buffer exceeded ${ElodinRelayClient.MAX_BUFFER_BYTES} bytes — resetting`);
      this.buffer = Buffer.alloc(0);
    }

    while (this.buffer.length >= 4) {
      const packetLen = this.buffer.readUInt32LE(0);

      if (packetLen < 4 || packetLen > 65536) {
        const syncOffset = this.findSyncOffset();
        if (syncOffset > 0) {
          this.buffer = this.buffer.subarray(syncOffset);
        } else {
          this.buffer = this.buffer.subarray(4);
        }
        continue;
      }
      if (this.buffer.length < packetLen + 4) break;

      const packet = this.buffer.subarray(0, packetLen + 4);
      this.buffer = this.buffer.subarray(packetLen + 4);

      const header: ElodinPacketHeader = {
        len: packet.readUInt32LE(0),
        ty: packet.readUInt8(4) as ElodinPacketType,
        packetId: [packet.readUInt8(5), packet.readUInt8(6)],
        requestId: packet.readUInt8(7),
      };

      const payload = packet.subarray(8);
      this.emit('packet', header, payload);
    }
  }

  /** Find offset of next valid packet to recover from chunking/misalignment. */
  private findSyncOffset(): number {
    for (let i = 1; i <= Math.min(64, this.buffer.length - 8); i++) {
      const len = this.buffer.readUInt32LE(i);
      if (len >= 4 && len <= 65536 && this.buffer.length >= i + 4 + len) {
        const ty = this.buffer.readUInt8(i + 4);
        if (ty <= 3) return i; // ElodinPacketType 0-3
      }
    }
    return 0;
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  /** Publish TABLE packet via relay (relay forwards to Elodin). Use when direct Elodin connection fails. */
  publishTable(packetId: [number, number], payload: Buffer): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      const msg = { type: 'publish', packetId, payload: payload.toString('base64') };
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }
}
