/**
 * REST API client for Elodin DB queries
 * Provides functions to query historical data from the backend
 */

import { SensorUpdate } from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8082';

export interface QueryOptions {
  packetIdHigh: number; // e.g., 0x20
  packetIdLow: number;  // e.g., 0x11
  startTime?: number;   // Unix timestamp in milliseconds
  endTime?: number;     // Unix timestamp in milliseconds
  limit?: number;       // Max number of records
}

export interface QueryResponse {
  packetId: [number, number];
  data: SensorUpdate[];
  timestamp: number;
}

export interface SensorInfo {
  packet_id: [number, number];
  packet_id_hex: string;
}

export interface SensorsListResponse {
  sensors: SensorInfo[];
}

/**
 * Query historical data from Elodin DB
 */
export async function queryHistoricalData(options: QueryOptions): Promise<QueryResponse> {
  const params = new URLSearchParams();
  params.append('packet_id_high', options.packetIdHigh.toString(16));
  params.append('packet_id_low', options.packetIdLow.toString(16));
  if (options.startTime !== undefined) {
    params.append('start_time', options.startTime.toString());
  }
  if (options.endTime !== undefined) {
    params.append('end_time', options.endTime.toString());
  }
  if (options.limit !== undefined) {
    params.append('limit', options.limit.toString());
  }

  const response = await fetch(`${API_BASE_URL}/api/query?${params.toString()}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Get list of all available sensors (subscribed packet IDs)
 */
export async function getSensorList(): Promise<SensorsListResponse> {
  const response = await fetch(`${API_BASE_URL}/api/sensors`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Get latest value for a specific entity
 * Note: This is a placeholder - use WebSocket for real-time data
 */
export async function getSensorValue(entity: string): Promise<{ entity: string; message: string }> {
  const response = await fetch(`${API_BASE_URL}/api/sensors/${encodeURIComponent(entity)}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Helper: Convert packet ID hex string to numbers
 * Example: "0x20,0x11" -> [0x20, 0x11]
 */
export function parsePacketIdHex(hexString: string): [number, number] {
  const parts = hexString.split(',');
  if (parts.length !== 2) {
    throw new Error(`Invalid packet ID format: ${hexString}`);
  }
  const high = parseInt(parts[0].replace('0x', ''), 16);
  const low = parseInt(parts[1].replace('0x', ''), 16);
  return [high, low];
}

/**
 * Helper: Convert packet ID numbers to hex string
 * Example: [0x20, 0x11] -> "0x20,0x11"
 */
export function formatPacketIdHex(packetId: [number, number]): string {
  const [high, low] = packetId;
  return `0x${high.toString(16).padStart(2, '0')},0x${low.toString(16).padStart(2, '0')}`;
}



