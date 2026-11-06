/** The video pane's view of /api/video/streams. Streams carry no URL or credential. */
import { getApiBaseUrl } from '@/lib/websocket';
import type { VideoLayout } from './layout';

export interface VideoStreamInfo {
  id: string;
  label: string;
  kind: 'rtsp' | 'udp';
  hasLowRes: boolean;
  record: boolean;
}

export interface GatewayStatus {
  /** Where the backend looks for the gateway. */
  host: string;
  reachable: boolean;
  error?: string;
  lastSyncAt?: number;
}

export interface VideoStreamsResponse {
  streams: VideoStreamInfo[];
  /** The stand layout (config/video.json). */
  layout: VideoLayout;
  errors: string[];
  gateway: GatewayStatus;
}

export async function fetchVideoStreams(signal?: AbortSignal): Promise<VideoStreamsResponse> {
  const res = await fetch(`${getApiBaseUrl()}/api/video/streams`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Editing ──────────────────────────────────────────────────────────────────

/** A stream as the editor sees it. The password itself is never sent to a browser. */
export type EditableStream = (
  | { id: string; label: string; kind: 'rtsp'; url: string; lowResUrl?: string; record: boolean }
  /** MPEG-TS pushed to the gateway over UDP (the HiDes link). */
  | { id: string; label: string; kind: 'udp'; port: number; record: boolean }
) & { username: string; passwordSet: boolean };

/** UDP ports a pushed stream may use (the backend's UDP_PORTS; bootstrap opens them). */
export const UDP_PORTS = { first: 5600, last: 5609 } as const;

export interface EditableConfig {
  revision: string;
  streams: EditableStream[];
  layout: VideoLayout;
  /** This machine's gateway: host ('' = this machine) and whether a password is saved. */
  gateway: { host: string; passwordSet: boolean };
  /** Where a pushed (UDP) stream should be sent from another machine. */
  ingestHost: string;
}

/** host: '' = this machine. password: omit to keep, null to clear, string to set. */
export interface GatewayChange {
  host: string;
  password?: string | null;
}

/** username: set ('' clears). password: omit to keep, null to clear, string to set. */
export interface CredentialChange {
  username?: string;
  password?: string | null;
}

export class VideoApiError extends Error {
  constructor(readonly status: number, readonly errors: string[]) {
    super(errors.join('; '));
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  if (!res.ok) throw new VideoApiError(res.status, json?.errors ?? [json?.error ?? `HTTP ${res.status}`]);
  return json as T;
}

export const fetchVideoConfig = () => call<EditableConfig>('GET', '/api/video/config');

export const saveVideoConfig = (
  revision: string,
  streams: unknown[],
  credentials: Record<string, CredentialChange>,
  layout: VideoLayout,
  gateway: GatewayChange,
) => call<EditableConfig>('PUT', '/api/video/config', { revision, streams, credentials, layout, gateway });

export const createPreview = (input: { url: string; username?: string; password?: string; fromStreamId?: string }) =>
  call<{ id: string }>('POST', '/api/video/previews', input);

export const deletePreview = (id: string) => call<void>('DELETE', `/api/video/previews/${encodeURIComponent(id)}`);
