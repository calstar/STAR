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
        ws.on('close', () => {
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

  private drainPackets(): void {
    while (this.buffer.length >= 4) {
      const packetLen = this.buffer.readUInt32LE(0);
      if (packetLen < 12 || packetLen > 65536) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      if (this.buffer.length < packetLen) break;
      const packet = this.buffer.subarray(0, packetLen);
      this.buffer = this.buffer.subarray(packetLen);
      const header: ElodinPacketHeader = {
        len: packet.readUInt32LE(0),
        ty: packet.readUInt8(4) as ElodinPacketType,
        packetId: [packet.readUInt8(5), packet.readUInt8(6)],
        requestId: packet.readUInt8(11),
      };
      const payload = packet.subarray(12);
      this.emit('packet', header, payload);
    }
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
}
