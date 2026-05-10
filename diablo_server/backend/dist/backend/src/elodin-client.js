/**
 * Elodin Database TCP Client
 * Connects to Elodin DB on port 2240 and handles protocol communication
 */
import { Socket } from 'net';
import { EventEmitter } from 'events';
export var ElodinPacketType;
(function (ElodinPacketType) {
    ElodinPacketType[ElodinPacketType["MSG"] = 0] = "MSG";
    ElodinPacketType[ElodinPacketType["TABLE"] = 1] = "TABLE";
    ElodinPacketType[ElodinPacketType["COMMAND"] = 2] = "COMMAND";
    ElodinPacketType[ElodinPacketType["QUERY"] = 3] = "QUERY";
})(ElodinPacketType || (ElodinPacketType = {}));
export class ElodinClient extends EventEmitter {
    socket = null;
    host;
    port;
    _connected = false;
    reconnectTimer = null;
    buffer = Buffer.alloc(0);
    hasReceivedData = false;
    writeQueue = [];
    drainPending = false;
    processingPackets = false;
    get connected() {
        return this._connected;
    }
    PACKET_IDS = {
        COMMAND: [0xff, 0x01],
        STATE_MACHINE: [0x20, 0x00],
    };
    constructor(host = 'localhost', port = 2240) {
        super();
        this.host = host;
        this.port = port;
    }
    async connect() {
        if (this._connected) {
            return true;
        }
        return new Promise((resolve) => {
            let connectTimeout = null;
            try {
                this.socket = new Socket();
                this.socket.setNoDelay(true); // Disable Nagle's algorithm for low latency
                this.socket.setKeepAlive(true, 60000); // Keep connection alive
                this.socket.on('data', (data) => {
                    if (!this.hasReceivedData) {
                        console.log(`[ElodinClient] First data chunk: ${data.length} bytes`);
                        this.hasReceivedData = true;
                    }
                    this.handleData(data);
                });
                connectTimeout = setTimeout(() => {
                    if (!this._connected) {
                        console.error(`[ElodinClient] Connection timeout to ${this.host}:${this.port}`);
                        this.socket?.destroy();
                        resolve(false);
                    }
                }, 5000);
                this.socket.on('connect', () => {
                    if (connectTimeout)
                        clearTimeout(connectTimeout);
                    this._connected = true;
                    this.emit('connected');
                    console.log(`[ElodinClient] Connected to ${this.host}:${this.port}`);
                    resolve(true);
                });
                this.socket.on('error', (error) => {
                    if (connectTimeout)
                        clearTimeout(connectTimeout);
                    const err = error;
                    console.error(`[ElodinClient] Socket error: ${err.code || err.message}`);
                    this._connected = false;
                    resolve(false);
                    this.scheduleReconnect();
                });
                this.socket.on('close', () => {
                    console.log('[ElodinClient] Connection closed');
                    this._connected = false;
                    this.writeQueue = [];
                    this.drainPending = false;
                    this.emit('disconnected');
                    this.scheduleReconnect();
                });
                try {
                    this.socket.connect(this.port, this.host);
                }
                catch (connectError) {
                    console.error('[ElodinClient] Failed to initiate connection:', connectError);
                    clearTimeout(connectTimeout);
                    resolve(false);
                }
            }
            catch (error) {
                console.error('[ElodinClient] Failed to connect:', error);
                this._connected = false;
                this.scheduleReconnect();
                resolve(false);
            }
        });
    }
    // Never drop the whole buffer on overload — trim oldest tail only at hard cap.
    // Parsing runs cooperatively (setImmediate) so we avoid socket pause/resume.
    static MAX_BUFFER_BYTES = 128 * 1024 * 1024;
    static TRIM_KEEP_TAIL_BYTES = 4 * 1024 * 1024;
    isLikelyDataPacket(packetId) {
        const [high] = packetId;
        // Data-bearing packet families used by the stack.
        // Excludes most registration/control MSG traffic that can flood the event loop.
        return (high === 0x10 || // heartbeats
            high === 0x20 || high === 0x21 || high === 0x22 || high === 0x23 || high === 0x24 || // PT/TC/RTD/LC/ENC
            high === 0x30 || high === 0x31 || high === 0x32 || // ACT raw/cal/commanded
            high === 0x40 || high === 0x41 || high === 0x42 || high === 0x43 || high === 0x44 || // controller
            high === 0x46 || // calibration commands
            high === 0x50 || // sequencer/PSM
            high === 0x60 // self-test
        );
    }
    handleData(data) {
        // Avoid an extra copy when buffer is empty.
        this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data]);
        // Hard safety cap: keep the most recent tail (best chance of re-sync).
        if (this.buffer.length > ElodinClient.MAX_BUFFER_BYTES) {
            console.error(`[ElodinClient] ❌ Buffer exceeded hard cap ${ElodinClient.MAX_BUFFER_BYTES} bytes — trimming oldest`);
            this.buffer = this.buffer.subarray(this.buffer.length - ElodinClient.TRIM_KEEP_TAIL_BYTES);
        }
        // Parse in cooperative chunks so heavy Elodin bursts can't starve Node's event loop
        // (HTTP/WS handshakes were timing out under sustained hardware traffic).
        if (!this.processingPackets) {
            this.processingPackets = true;
            this.processBufferedPackets();
        }
    }
    processBufferedPackets() {
        const MAX_PACKETS_PER_TICK = 1000;
        let processed = 0;
        // Protocol: len(4) = payload + 4 (ty+packetId+requestId). Total packet = 4 + len.
        while (this.buffer.length >= 4 && processed < MAX_PACKETS_PER_TICK) {
            const packetLen = this.buffer.readUInt32LE(0);
            if (this.buffer.length < packetLen + 4)
                break;
            // len >= 4 (empty payload valid); reject obviously corrupt values
            if (packetLen < 4 || packetLen > 65536) {
                const syncOffset = this.findSyncOffset();
                if (syncOffset > 0) {
                    this.buffer = this.buffer.subarray(syncOffset);
                }
                else {
                    this.buffer = this.buffer.subarray(4);
                }
                continue;
            }
            const packet = this.buffer.subarray(0, packetLen + 4);
            this.buffer = this.buffer.subarray(packetLen + 4);
            const header = {
                len: packet.readUInt32LE(0),
                ty: packet.readUInt8(4),
                packetId: [packet.readUInt8(5), packet.readUInt8(6)],
                requestId: packet.readUInt8(7),
            };
            if (header.len < 4 || header.len > 65536) {
                console.error(`[ElodinClient] Invalid header.len=${header.len}`);
                continue;
            }
            const payload = packet.subarray(8);
            // Elodin can deliver stream rows as ty=TABLE(1) or ty=MSG(0) depending on path/version.
            // Accept TABLE always; accept MSG only for known data packet families to avoid
            // flooding the event loop with registration/control chatter.
            if (header.ty === ElodinPacketType.TABLE ||
                (header.ty === ElodinPacketType.MSG && this.isLikelyDataPacket(header.packetId))) {
                this.emit('packet', header, payload);
            }
            processed++;
        }
        if (this.buffer.length >= 4) {
            setImmediate(() => this.processBufferedPackets());
            return;
        }
        this.processingPackets = false;
    }
    /** Find offset of next valid packet to recover from chunking/misalignment. */
    findSyncOffset() {
        for (let i = 1; i <= Math.min(64, this.buffer.length - 8); i++) {
            const len = this.buffer.readUInt32LE(i);
            if (len >= 4 && len <= 65536 && this.buffer.length >= i + 4 + len) {
                const ty = this.buffer.readUInt8(i + 4);
                if (ty <= 3)
                    return i; // ElodinPacketType 0-3
            }
        }
        return 0;
    }
    /**
     * Send raw message to Elodin DB
     * Used for VTable registration and other low-level protocol messages
     */
    sendRawMessage(packetId, packetType, payload) {
        if (!this.connected || !this.socket) {
            return false;
        }
        try {
            const header = this.createHeader(packetType, payload.length, packetId);
            const packet = Buffer.concat([header, payload]);
            // If drain is pending, queue the packet rather than dropping it
            if (this.drainPending) {
                this.writeQueue.push(packet);
                return true;
            }
            const flushed = this.socket.write(packet);
            if (!flushed) {
                this.drainPending = true;
                if (!this.socket.listenerCount('drain')) {
                    this.socket.once('drain', () => {
                        this.drainPending = false;
                        this.flushWriteQueue();
                    });
                }
            }
            return true;
        }
        catch (error) {
            console.error('[ElodinClient] Failed to send raw message:', error);
            return false;
        }
    }
    /**
     * Publish a TABLE packet to Elodin DB
     * This is used to send sensor data to Elodin DB (like DAQ Bridge does)
     *
     * @param packetId Packet ID [high, low] (e.g., [0x20, 0x01] for PT Raw CH1)
     * @param payload Postcard-encoded message payload
     * @returns true if published successfully
     */
    publishTable(packetId, payload) {
        return this.sendRawMessage(packetId, ElodinPacketType.TABLE, payload);
    }
    sendCommand(commandType, data) {
        if (!this.connected || !this.socket) {
            return false;
        }
        try {
            const commandData = {
                type: commandType,
                data,
                timestamp: Date.now(),
            };
            const payload = JSON.stringify(commandData);
            const payloadBuffer = Buffer.from(payload, 'utf-8');
            const packetId = commandType === 'state_transition'
                ? [this.PACKET_IDS.STATE_MACHINE[0], this.PACKET_IDS.STATE_MACHINE[1]]
                : [this.PACKET_IDS.COMMAND[0], this.PACKET_IDS.COMMAND[1]];
            return this.sendRawMessage(packetId, ElodinPacketType.COMMAND, payloadBuffer);
        }
        catch (error) {
            console.error('[ElodinClient] Failed to send command:', error);
            return false;
        }
    }
    createHeader(type, payloadLength, packetId = [0, 0]) {
        const header = Buffer.alloc(8);
        const totalLen = 8 + payloadLength;
        header.writeUInt32LE(totalLen - 4, 0); // Elodin len = total - 4
        header.writeUInt8(type, 4);
        header.writeUInt8(packetId[0], 5);
        header.writeUInt8(packetId[1], 6);
        header.writeUInt8(0, 7); // requestId
        return header;
    }
    flushWriteQueue() {
        if (!this.socket || !this._connected) {
            this.writeQueue = [];
            return;
        }
        while (this.writeQueue.length > 0) {
            const pkt = this.writeQueue.shift();
            const flushed = this.socket.write(pkt);
            if (!flushed) {
                this.drainPending = true;
                this.socket.once('drain', () => {
                    this.drainPending = false;
                    this.flushWriteQueue();
                });
                return;
            }
        }
    }
    scheduleReconnect() {
        if (this.reconnectTimer) {
            return;
        }
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.connected) {
                console.log('[ElodinClient] Reconnecting...');
                this.connect();
            }
        }, 5000); // Reconnect after 5 seconds
    }
    disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.writeQueue = [];
        this.drainPending = false;
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this._connected = false;
    }
    isConnected() {
        return this._connected;
    }
}
