/**
 * Actuator control logic — UDP command sending, board mapping, NC/NO conversion,
 * continuous commands, and expected-position broadcasts.
 * Extracted from server.ts.
 */

import * as dgram from 'dgram';
import * as net from 'net';
import { WebSocket } from 'ws';
import { readConfig } from './routes/config.js';
import { getActuatorChannel, CSV_ACTUATOR_TO_ENTITY } from './routes/state-actuators.js';
import type { StateActuatorMap } from './routes/state-actuators.js';
import {
    MessageType,
    SystemState,
} from '../../shared/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types used by the server to interact with this module
// ═══════════════════════════════════════════════════════════════════════════════

/** Minimal interface for the parts of SensorSystemServer that actuator-control needs. */
export interface ActuatorHost {
    actuatorSocket: dgram.Socket | null;
    actuatorIP: string;
    actuatorPort: number;
    actuatorBoardMap: Map<string, { channel: number; boardIp: string }>;
    actuatorBoardIPs: Set<string>;
    manuallyCommandedChannels: Set<string>;
    actuatorCommandInterval: NodeJS.Timeout | null;
    currentState: SystemState | null;
    ACTUATOR_COMMAND_INTERVAL_MS: number;
    broadcast(message: any): void;
    send(ws: WebSocket, message: any): void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Actuator board map loading
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load actuator board mappings from config (multi-board support).
 * Maps actuator name → { channel, boardIp } for routing commands to correct board.
 */
export function loadActuatorBoardMap(
    config: any,
    host: ActuatorHost,
): void {
    try {
        const actuatorRoles = config.actuator_roles || {};
        const boards = config.boards || {};

        host.actuatorBoardIPs.clear();
        for (const [boardKey, boardConfig] of Object.entries(boards)) {
            const board = boardConfig as any;
            if (board.type === 'ACTUATOR' && board.enabled !== false && board.ip) {
                host.actuatorBoardIPs.add(board.ip);
                console.log(`📋 Registered actuator board IP: ${board.ip}`);
            }
        }

        /** Resolve board_id to IP from config.boards (sensors/actuators are mapped by board_id, not IP). */
        const boardIdToIp = new Map<number, string>();
        for (const [, boardConfig] of Object.entries(boards)) {
            const board = boardConfig as any;
            const id = typeof board.id === 'number' ? board.id : (typeof board.board_id === 'number' ? board.board_id : null);
            const ip = typeof board.ip === 'string' ? board.ip : (id != null ? `192.168.2.${id}` : '');
            if (id != null && ip) boardIdToIp.set(id, ip);
        }

        let defaultBoardIp = '';
        for (const [, boardConfig] of Object.entries(boards)) {
            const board = boardConfig as any;
            if (board.type === 'ACTUATOR' && board.enabled !== false) {
                defaultBoardIp = board.ip || defaultBoardIp;
                break;
            }
        }

        for (const [name, value] of Object.entries(actuatorRoles)) {
            if (Array.isArray(value)) {
                const type = value[0] as string;
                const channel = value[1] as number;
                let boardIp = defaultBoardIp;
                if (value.length >= 3) {
                    if (typeof value[2] === 'number') {
                        boardIp = boardIdToIp.get(value[2]) || defaultBoardIp;
                    } else if (typeof value[2] === 'string') {
                        boardIp = value[2]; // legacy board_ip string
                    }
                }

                host.actuatorBoardMap.set(name, { channel, boardIp });
                console.log(`📋 Actuator mapping: ${name} → CH${channel} @ ${boardIp}`);
            }
        }

        console.log(`✅ Loaded ${host.actuatorBoardMap.size} actuator board mappings`);
        console.log(`✅ Registered ${host.actuatorBoardIPs.size} actuator board IPs for filtering: ${Array.from(host.actuatorBoardIPs).join(', ')}`);
    } catch (error) {
        console.error('❌ Failed to load actuator board map:', error);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Actuator info helpers
// ═══════════════════════════════════════════════════════════════════════════════

export function getActuatorBoardInfo(host: ActuatorHost, actuatorName: string): { channel: number; boardIp: string } | null {
    return host.actuatorBoardMap.get(actuatorName) || null;
}

export function getActuatorType(actuatorName: string): 'NC' | 'NO' {
    try {
        const config = readConfig();
        const roles = config.actuator_roles || {};
        const roleValue = roles[actuatorName];
        if (Array.isArray(roleValue) && roleValue.length >= 2 && typeof roleValue[0] === 'string') {
            return roleValue[0] === 'NO' ? 'NO' : 'NC';
        }
    } catch (error) {
        console.warn(`⚠️ Could not look up actuator type for "${actuatorName}" from config`);
    }
    return 'NC';
}

export function getActuatorTypeByChannel(channelId: number): 'NC' | 'NO' {
    try {
        const config = readConfig();
        const roles = config.actuator_roles || {};
        for (const [name, value] of Object.entries(roles)) {
            if (Array.isArray(value) && value.length >= 2 && typeof value[1] === 'number' && value[1] === channelId) {
                if (typeof value[0] === 'string') {
                    return value[0] === 'NO' ? 'NO' : 'NC';
                }
            }
        }
    } catch (error) {
        console.warn(`⚠️ Could not look up actuator type for channel ${channelId} from config`);
    }
    return 'NC';
}

export function getActuatorNameByChannel(channelId: number): string | null {
    try {
        const config = readConfig();
        const roles = config.actuator_roles || {};
        for (const [name, value] of Object.entries(roles)) {
            if (Array.isArray(value) && value.length >= 2 && typeof value[1] === 'number' && value[1] === channelId) {
                return name;
            }
        }
    } catch (_) { /* ignore */ }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GUI↔Hardware state conversion
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert GUI state (open/closed) to hardware state (on/off) based on NC/NO type.
 * NC: OPEN (1) -> hardware ON (1), CLOSED (0) -> hardware OFF (0)
 * NO: OPEN (1) -> hardware OFF (0), CLOSED (0) -> hardware ON (1) [INVERTED]
 */
export function guiStateToHardwareState(guiState: number, actuatorType: 'NC' | 'NO'): number {
    if (actuatorType === 'NO') {
        return guiState === 1 ? 0 : 1;
    } else {
        return guiState;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UDP command sending — routed through daq_bridge proxy on 127.0.0.1:5557
// Proxy format: [dest_ip(4B big-endian) | dest_port(2B LE) | payload...]
// ═══════════════════════════════════════════════════════════════════════════════

/** Send payload directly to board IP:port. */
function sendUdp(host: ActuatorHost, destIp: string, destPort: number, payload: Buffer): boolean {
    if (!host.actuatorSocket) return false;
    host.actuatorSocket.send(payload, 0, payload.length, destPort, destIp, (err) => {
        if (err) {
            const e = err as any;
            console.error(`❌ UDP to ${destIp}:${destPort}: ${e.code || ''} ${e.message}`);
            _recreateSocket(host);
        }
    });
    return true;
}

/**
 * Send actuator command via UDP (matches combined_gui.py packet format).
 */
export function sendActuatorCommandUDP(
    host: ActuatorHost,
    channelId: number,
    state: number,
    boardIp?: string,
): boolean {
    const targetIp = boardIp || host.actuatorIP;

    if (!host.actuatorSocket) {
        console.error('❌ Actuator socket not initialized - attempting to recreate...');
        try {
            host.actuatorSocket = dgram.createSocket('udp4');
            host.actuatorSocket.on('error', (err: Error) => {
                console.error(`❌ Actuator socket error: ${err.message}`);
            });
            console.log('✅ Actuator socket recreated');
        } catch (error) {
            console.error('❌ Failed to recreate actuator socket:', error);
            return false;
        }
    }

    try {
        const socketState = (host.actuatorSocket as any).closed;
        if (socketState === true) {
            console.error('❌ Actuator socket is closed - recreating...');
            host.actuatorSocket = dgram.createSocket('udp4');
            host.actuatorSocket.on('error', (err: Error) => {
                console.error(`❌ Actuator socket error: ${err.message}`);
            });
        }
    } catch (checkError) {
        // Socket might not have 'closed' property, that's OK
    }

    try {
        if (channelId < 1 || channelId > 10) {
            console.error(`❌ Invalid channel ID: ${channelId} (must be 1-10)`);
            return false;
        }
        if (state !== 0 && state !== 1) {
            console.error(`❌ Invalid state: ${state} (must be 0 or 1)`);
            return false;
        }

        const nowMs = Date.now();
        if (!isFinite(nowMs) || nowMs < 0) {
            console.error(`❌ Invalid timestamp: ${nowMs}`);
            return false;
        }
        const timestamp = (Math.floor(nowMs) >>> 0);

        const packetType = 4;
        const version = 0;
        const numCommands = 1;

        const buffer = Buffer.alloc(9, 0);
        let offset = 0;

        buffer.writeUInt8(packetType, offset);
        offset += 1;
        buffer.writeUInt8(version, offset);
        offset += 1;

        if (offset + 4 > buffer.length) {
            console.error(`❌ Buffer overflow: offset ${offset} + 4 > ${buffer.length}`);
            return false;
        }
        try {
            buffer.writeUInt32LE(timestamp, offset);
        } catch (writeError) {
            const err = writeError as any;
            console.error(`❌ Buffer writeUInt32LE error at offset ${offset}: ${err.code || 'UNKNOWN'} — ${err.message}`);
            return false;
        }
        offset += 4;

        buffer.writeUInt8(numCommands, offset);
        offset += 1;
        buffer.writeUInt8(channelId, offset);
        offset += 1;
        buffer.writeUInt8(state, offset);
        offset += 1;

        if (offset !== 9) {
            console.error(`❌ Buffer write error: wrote ${offset} bytes, expected 9`);
            return false;
        }
        if (buffer.length !== 9) {
            console.error(`❌ Buffer size mismatch: expected 9, got ${buffer.length}`);
            return false;
        }

        if (!host.actuatorSocket) {
            console.error('❌ Actuator socket became null before send');
            return false;
        }

        return sendUdp(host, targetIp, host.actuatorPort, buffer);
    } catch (error) {
        console.error('❌ Error sending actuator command:', error);
        _recreateSocket(host);
        return false;
    }
}

/**
 * Send PWM actuator command via UDP (matches combined_gui.py format).
 */
export function sendPWMActuatorCommandUDP(
    host: ActuatorHost,
    channelId: number,
    dutyCycle: number,
    frequency: number = 10,
    durationMs: number = 1000,
    boardIp?: string,
): boolean {
    const targetIp = boardIp || host.actuatorIP;

    if (!host.actuatorSocket) {
        console.error('❌ Actuator socket not initialized');
        return false;
    }

    try {
        const packetType = 10;
        const version = 0;
        const timestamp = (Date.now() >>> 0);
        const numCommands = 1;

        const buffer = Buffer.allocUnsafe(20);
        let offset = 0;

        buffer.writeUInt8(packetType, offset++);
        buffer.writeUInt8(version, offset++);
        buffer.writeUInt32LE(timestamp, offset);
        offset += 4;
        buffer.writeUInt8(numCommands, offset++);
        buffer.writeUInt8(channelId, offset++);
        buffer.writeUInt32LE(durationMs, offset);
        offset += 4;
        buffer.writeFloatLE(dutyCycle, offset);
        offset += 4;
        buffer.writeFloatLE(frequency, offset);
        offset += 4;

        return sendUdp(host, targetIp, host.actuatorPort, buffer);
    } catch (error) {
        console.error('❌ Error sending PWM command:', error);
        _recreateSocket(host);
        return false;
    }
}

/** Map SystemState enum key to CSV state name (state_machine_actuators.csv headers). */
const STATE_TO_CSV_NAME: Record<string, string> = {
  IDLE: 'Idle', ARMED: 'Armed', FUEL_FILL: 'Fuel Fill', OX_FILL: 'Ox Fill',
  PRESS_STANDBY: 'Press Standby', GN2_LOW_PRESS: 'GN2 Low Press', GN2_VENT: 'GN2 Low Vent',
  FUEL_PRESS: 'Fuel Press', FUEL_VENT: 'Fuel Vent', OX_PRESS: 'Ox Press', OX_VENT: 'Ox Vent',
  GN2_HIGH_PRESS: 'GN2 High Press', GN2_HIGH_VENT: 'GN2 High Vent', CALIBRATE: 'Calibrate',
  READY: 'Ready', FIRE: 'Fire', VENT: 'Vent',
  ENGINE_ABORT: 'Engine Abort', GSE_ABORT: 'GSE Abort', EMERGENCY_ABORT: 'Emergency Abort',
  DEBUG: 'Debug',
};

/** Forward state to C++ actuator_service (TCP). When configured, backend skips UDP. */
export async function forwardStateToActuatorService(stateName: string, port?: number): Promise<boolean> {
    let p = port ?? 0;
    if (!p || p < 1 || p > 65535) {
        p = process.env.ACTUATOR_SERVICE_PORT ? parseInt(process.env.ACTUATOR_SERVICE_PORT, 10) : 0;
    }
    if (!p || p < 1 || p > 65535) {
        try {
            const cfg = readConfig();
            const c = (cfg as any).actuator_service?.port;
            if (typeof c === 'number' && c >= 1 && c <= 65535) p = c;
        } catch (_) { /* ignore */ }
    }
    if (!p || p < 1 || p > 65535) return false;

    return new Promise<boolean>((resolve) => {
        const csvName = STATE_TO_CSV_NAME[stateName] ?? stateName;
        const socket = net.connect({ host: '127.0.0.1', port: p }, () => {
            socket.write(`STATE:${csvName}\n`, (err?: Error | null) => {
                if (err) {
                    console.error(`[ActuatorService] Write error: ${err.message}`);
                    resolve(false);
                } else {
                    console.log(`[ActuatorService] Forwarded state ${stateName} to C++ service`);
                    resolve(true);
                }
                socket.end();
            });
        });
        socket.on('error', (err: Error) => {
            console.warn(`[ActuatorService] Connection failed (port ${p}): ${err.message}`);
            resolve(false);
        });
        socket.setTimeout(2000, () => {
            socket.destroy();
            resolve(false);
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// State-based actuator automation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Auto-command actuators to match expected positions for a given state.
 */
export function applyActuatorsForState(
    host: ActuatorHost,
    state: SystemState,
    STATE_ACTUATOR_MAP: StateActuatorMap,
): void {
    const expected = STATE_ACTUATOR_MAP[state];
    if (!expected) {
        console.log(`⚠️ No actuator map for state ${SystemState[state]}, skipping auto-command`);
        return;
    }

    let configActuatorChannels: Record<string, number> = {};
    try {
        const config = readConfig();
        const roles = config.actuator_roles || {};
        for (const [name, value] of Object.entries(roles)) {
            if (Array.isArray(value) && value.length >= 2 && typeof value[1] === 'number') {
                configActuatorChannels[name] = value[1];
            }
        }
    } catch (_) { /* ignore */ }

    console.log(`🔧 Auto-commanding actuators for state ${SystemState[state]}:`);

    const commandedChannels = new Set<string>();

    for (const [actuatorName, val] of Object.entries(expected)) {
        const boardInfo = getActuatorBoardInfo(host, actuatorName);
        if (!boardInfo) {
            const channelId = getActuatorChannel(actuatorName, configActuatorChannels);
            if (channelId === undefined || isNaN(channelId) || channelId < 1 || channelId > 10) {
                console.warn(`⚠️ No valid channel for actuator "${actuatorName}" - skipping`);
                continue;
            }
            const channelKey = `${channelId}@${host.actuatorIP}`;
            if (commandedChannels.has(channelKey)) {
                console.log(`   (${actuatorName}) CH${channelId} already commanded - skipping duplicate`);
                continue;
            }
            commandedChannels.add(channelKey);
            const actuatorType = getActuatorType(actuatorName);
            const hardwareState = guiStateToHardwareState(val, actuatorType);

            if (actuatorName === 'LOX Press') {
                if (actuatorType !== 'NO') {
                    console.error(`   ❌❌❌ CRITICAL BUG: LOX Press detected as ${actuatorType} instead of NO! This will cause inverted commands!`);
                }
                console.log(`   🔍 LOX Press: GUI=${val} (${val === 1 ? 'OPEN' : 'CLOSED'}) → Type=${actuatorType} → HW=${hardwareState} (${hardwareState === 1 ? 'ON' : 'OFF'})`);
            }

            sendActuatorCommandUDP(host, channelId, hardwareState);
            const guiStateStr = val === 1 ? 'OPEN' : 'CLOSED';
            const hwStateStr = hardwareState === 1 ? 'ON' : 'OFF';
            console.log(`   ${actuatorName} CH${channelId} @ ${host.actuatorIP} → GUI:${guiStateStr} (${val}) → HW:${hwStateStr} (${hardwareState}) [${actuatorType}]`);
            continue;
        }

        const { channel: channelId, boardIp } = boardInfo;
        if (channelId < 1 || channelId > 10) {
            console.warn(`⚠️ Invalid channel ${channelId} for actuator "${actuatorName}" - skipping`);
            continue;
        }

        const channelKey = `${channelId}@${boardIp}`;
        if (commandedChannels.has(channelKey)) {
            console.log(`   (${actuatorName}) CH${channelId} @ ${boardIp} already commanded - skipping duplicate`);
            continue;
        }
        commandedChannels.add(channelKey);

        const actuatorType = getActuatorType(actuatorName);
        const hardwareState = guiStateToHardwareState(val, actuatorType);

        if (actuatorName === 'LOX Press') {
            if (actuatorType !== 'NO') {
                console.error(`   ❌❌❌ CRITICAL BUG: LOX Press detected as ${actuatorType} instead of NO! This will cause inverted commands!`);
            }
            console.log(`   🔍 LOX Press: GUI=${val} (${val === 1 ? 'OPEN' : 'CLOSED'}) → Type=${actuatorType} → HW=${hardwareState} (${hardwareState === 1 ? 'ON' : 'OFF'})`);
        }

        sendActuatorCommandUDP(host, channelId, hardwareState, boardIp);
        const guiStateStr = val === 1 ? 'OPEN' : 'CLOSED';
        const hwStateStr = hardwareState === 1 ? 'ON' : 'OFF';
        console.log(`   ${actuatorName} CH${channelId} @ ${boardIp} → GUI:${guiStateStr} (${val}) → HW:${hwStateStr} (${hardwareState}) [${actuatorType}]`);
    }
}

/**
 * Start continuously sending actuator commands for the current state.
 */
export function startContinuousActuatorCommands(
    host: ActuatorHost,
    state: SystemState,
    STATE_ACTUATOR_MAP: StateActuatorMap,
): void {
    stopContinuousActuatorCommands(host);

    const expected = STATE_ACTUATOR_MAP[state];
    if (!expected) return;

    let configActuatorChannels: Record<string, number> = {};
    try {
        const config = readConfig();
        const roles = config.actuator_roles || {};
        for (const [name, value] of Object.entries(roles)) {
            if (Array.isArray(value) && value.length >= 2 && typeof value[1] === 'number') {
                configActuatorChannels[name] = value[1];
            }
        }
    } catch (_) { /* ignore */ }

    const channelCommands: Map<string, { actuatorName: string; guiState: number; boardIp: string; channel: number }> = new Map();
    for (const [actuatorName, val] of Object.entries(expected)) {
        const boardInfo = getActuatorBoardInfo(host, actuatorName);
        if (!boardInfo) {
            const channelId = getActuatorChannel(actuatorName, configActuatorChannels);
            if (channelId === undefined || channelId < 1 || channelId > 10) continue;
            const channelKey = `${channelId}@${host.actuatorIP}`;
            if (!channelCommands.has(channelKey)) {
                channelCommands.set(channelKey, { actuatorName, guiState: val, boardIp: host.actuatorIP, channel: channelId });
            }
            continue;
        }

        const { channel: channelId, boardIp } = boardInfo;
        if (channelId < 1 || channelId > 10) continue;
        const channelKey = `${channelId}@${boardIp}`;
        if (!channelCommands.has(channelKey)) {
            channelCommands.set(channelKey, { actuatorName, guiState: val, boardIp, channel: channelId });
        }
    }

    if (channelCommands.size === 0) return;

    console.log(`🔄 Starting continuous actuator commands for state ${SystemState[state]} (every ${host.ACTUATOR_COMMAND_INTERVAL_MS}ms)`);

    host.actuatorCommandInterval = setInterval(() => {
        if (host.currentState === state) {
            for (const [channelKey, cmd] of channelCommands.entries()) {
                const channelNum = cmd.channel;
                const channelKeyWithIp = `${channelNum}@${cmd.boardIp}`;
                if (host.manuallyCommandedChannels.has(channelKeyWithIp)) {
                    // In FIRE state, skip press channels (managed by controller loop PWM)
                    if (state === SystemState.FIRE && (cmd.actuatorName === 'Fuel Press' ||
                        cmd.actuatorName === 'LOX Press')) {
                        continue;
                    }
                    continue;
                }
                const actuatorType = getActuatorType(cmd.actuatorName);
                const hardwareState = guiStateToHardwareState(cmd.guiState, actuatorType);
                sendActuatorCommandUDP(host, channelNum, hardwareState, cmd.boardIp);
            }
        } else {
            stopContinuousActuatorCommands(host);
        }
    }, host.ACTUATOR_COMMAND_INTERVAL_MS);
}

export function stopContinuousActuatorCommands(host: ActuatorHost): void {
    if (host.actuatorCommandInterval) {
        clearInterval(host.actuatorCommandInterval);
        host.actuatorCommandInterval = null;
        console.log('🛑 Stopped continuous actuator commands');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Expected-position broadcasts
// ═══════════════════════════════════════════════════════════════════════════════

export function sendActuatorExpectedPositionsToClient(
    host: ActuatorHost,
    ws: WebSocket,
    state: SystemState,
    STATE_ACTUATOR_MAP: StateActuatorMap,
): void {
    const expected = STATE_ACTUATOR_MAP[state];
    if (!expected) {
        host.send(ws, {
            type: MessageType.ACTUATOR_EXPECTED_POSITIONS_UPDATE,
            timestamp: Date.now(),
            payload: { [state]: {} },
        });
        return;
    }

    const entityExpected: Record<string, 'open' | 'closed'> = {};
    for (const [actuatorName, value] of Object.entries(expected)) {
        const entity = CSV_ACTUATOR_TO_ENTITY[actuatorName];
        if (entity) {
            entityExpected[entity] = value === 1 ? 'open' : 'closed';
        } else {
            const fallback = `ACT.${actuatorName.replace(/\s+/g, '_')}`;
            entityExpected[fallback] = value === 1 ? 'open' : 'closed';
        }
    }

    console.log(`📤 Sending expected actuator positions for state ${SystemState[state]} to client:`, entityExpected);

    host.send(ws, {
        type: MessageType.ACTUATOR_EXPECTED_POSITIONS_UPDATE,
        timestamp: Date.now(),
        payload: { [state]: entityExpected },
    });
}

export function broadcastActuatorExpectedPositions(
    host: ActuatorHost,
    state: SystemState,
    STATE_ACTUATOR_MAP: StateActuatorMap,
): void {
    const expected = STATE_ACTUATOR_MAP[state];
    if (!expected) {
        host.broadcast({
            type: MessageType.ACTUATOR_EXPECTED_POSITIONS_UPDATE,
            timestamp: Date.now(),
            payload: { [state]: {} },
        });
        return;
    }

    const entityExpected: Record<string, 'open' | 'closed'> = {};
    for (const [actuatorName, value] of Object.entries(expected)) {
        const entity = CSV_ACTUATOR_TO_ENTITY[actuatorName];
        if (entity) {
            entityExpected[entity] = value === 1 ? 'open' : 'closed';
        } else {
            const fallback = `ACT.${actuatorName.replace(/\s+/g, '_')}`;
            entityExpected[fallback] = value === 1 ? 'open' : 'closed';
        }
    }

    console.log(`📤 Broadcasting expected actuator positions for state ${SystemState[state]}:`, entityExpected);

    host.broadcast({
        type: MessageType.ACTUATOR_EXPECTED_POSITIONS_UPDATE,
        timestamp: Date.now(),
        payload: { [state]: entityExpected },
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════════════

function _recreateSocket(host: ActuatorHost): void {
    try {
        if (host.actuatorSocket) {
            host.actuatorSocket.close();
        }
        host.actuatorSocket = dgram.createSocket('udp4');
        host.actuatorSocket.on('error', (err: Error) => {
            console.error(`❌ Recreated socket error: ${err.message}`);
        });
        host.actuatorSocket.on('close', () => {
            console.warn('⚠️ Recreated actuator socket closed');
        });
        console.log(`✅ Actuator socket recreated`);
    } catch (recreateError) {
        console.error(`❌ Failed to recreate socket:`, recreateError);
        host.actuatorSocket = null;
    }
}
