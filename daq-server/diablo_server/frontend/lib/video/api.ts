/** The video pane's view of /api/video/streams. Streams carry no URL or credential. */
import { getApiBaseUrl } from '@/lib/websocket';
import type { VideoLayout } from './layout';

export interface VideoStreamInfo {
  id: string;
  label: string;
  kind: 'rtsp' | 'udp';
  hasLowRes: boolean;
  record: boolean;
  /** Zoom to fill the tile (crop) instead of letterboxing. */
  fill: boolean;
}

export interface GatewayStatus {
  /** Where the backend looks for the gateway. */
  host: string;
  reachable: boolean;
  error?: string;
  lastSyncAt?: number;
}

/** The rolling buffer, as the video agent on the gateway machine reports it. */
export interface RecordingState {
  active: boolean;
  /** Stop was pressed; the files are being written. */
  stopping?: boolean;
  folder?: string;
  startedAt?: number;
  streams?: string[];
  elapsedSeconds?: number;
}

export interface BufferStatus {
  available: boolean;
  error?: string;
  bufferSeconds?: number;
  buffered?: Record<string, number>;
  disk?: { freeBytes: number; totalBytes: number } | null;
  /** What the buffer is writing now, all streams together. */
  bytesPerSecond?: number;
  recording?: RecordingState;
  lastRecording?: (SaveResult & { startedAt: number; stoppedAt: number; reason: string }) | null;
  refuseBelowBytes?: number;
  stopBelowBytes?: number;
}

export interface SaveResult {
  folder: string;
  seconds: number;
  /** seconds: how much each kept file really covers (less than the window after a restart). */
  streams: { stream: string; file?: string; bytes?: number; seconds?: number; gaps?: number; error?: string }[];
}

export interface VideoStreamsResponse {
  streams: VideoStreamInfo[];
  buffer: BufferStatus;
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
  | { id: string; label: string; kind: 'rtsp'; url: string; lowResUrl?: string; record: boolean; fill?: boolean }
  /** MPEG-TS pushed to the gateway over UDP (the HiDes link). */
  | { id: string; label: string; kind: 'udp'; port: number; record: boolean; fill?: boolean }
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

/** Keep the last buffer window of every stream marked "include in recording" (on the gateway machine). */
export const saveBuffer = () => call<SaveResult>('POST', '/api/video/save');

/** One line for the operator: where it went, and anything that did not make it. */
export function describeSave(r: SaveResult): string {
  const ok = r.streams.filter((s) => s.file);
  const bad = r.streams.filter((s) => s.error);
  const folder = r.folder.split(/[\\/]/).pop();
  const covered = Math.min(...ok.map((s) => s.seconds ?? r.seconds));
  const span = covered >= 120 ? `${Math.round(covered / 60)} min` : `${covered} s`;
  const head = `saved ${ok.length} stream${ok.length === 1 ? '' : 's'} (last ${span}) to recordings/${folder}`;
  // A kept file plays straight across a gap (the gateway or a camera was down), so say so.
  const gapped = ok.filter((s) => (s.gaps ?? 0) > 0);
  const gaps = gapped.length ? `; gaps (stream was down) in ${gapped.map((s) => s.stream).join(', ')}` : '';
  return bad.length ? `${head}${gaps}; not saved: ${bad.map((b) => `${b.stream} (${b.error})`).join(', ')}` : `${head}${gaps}`;
}

export const startRecording = () => call<{ folder: string; startedAt: number; streams: string[] }>('POST', '/api/video/record/start');
export const stopRecording = () => call<SaveResult & { reason: string }>('POST', '/api/video/record/stop');

/** "12:04", "1:02:09" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * How long the gateway's disk lasts: free space down to the stop floor, at the rate the
 * buffer is writing (a recording keeps what the buffer writes, so the rate is the same).
 */
export function diskLeft(b: BufferStatus): string | null {
  if (!b.disk) return null;
  const usable = b.disk.freeBytes - (b.stopBelowBytes ?? 0);
  const gb = `${(b.disk.freeBytes / 1e9).toFixed(0)} GB free`;
  if (!b.bytesPerSecond || b.bytesPerSecond <= 0) return gb;
  const h = Math.max(0, usable) / b.bytesPerSecond / 3600;
  return `${gb}, ${h >= 1 ? `${Math.floor(h)} h ${Math.round((h % 1) * 60)} m` : `${Math.round(h * 60)} m`} at this rate`;
}

/** One line after Stop: where it went, how long, and anything missing or gappy. */
export function describeRecording(r: SaveResult & { reason: string; startedAt?: number; stoppedAt?: number }): string {
  const ok = r.streams.filter((s) => s.file);
  const bad = r.streams.filter((s) => s.error);
  const folder = r.folder.split(/[\\/]/).pop();
  const len = r.startedAt != null && r.stoppedAt != null ? ` ${clock((r.stoppedAt - r.startedAt) / 1000)}` : '';
  const why = r.reason === 'stopped' ? 'recorded' : `recording ended early (${r.reason}) --`;
  const gapped = ok.filter((s) => (s.gaps ?? 0) > 0);
  return `${why}${len}${r.reason === 'stopped' ? ',' : ''} ${ok.length} stream${ok.length === 1 ? '' : 's'} to recordings/${folder}`
    + (gapped.length ? `; gaps (stream was down) in ${gapped.map((s) => s.stream).join(', ')}` : '')
    + (bad.length ? `; not recorded: ${bad.map((b) => `${b.stream} (${b.error})`).join(', ')}` : '');
}

// ── Recordings on the gateway machine ─────────────────────────────────────────

export interface RecordingEntry {
  /** Folder name, e.g. 2026-11-06_141503_record */
  name: string;
  /** "save" or "record" */
  kind: string;
  startedAt: number;
  /** Still being recorded. */
  active: boolean;
  files: { stream: string; bytes: number }[];
  bytes: number;
}

export const listRecordings = () => call<{ dir: string; recordings: RecordingEntry[] }>('GET', '/api/video/recordings');

/** Open one recording (or, with no name, the recordings folder) in the gateway machine's file manager. */
export const openRecording = (name?: string) => call<{ opened: string }>('POST', '/api/video/recordings/open', name ? { name } : {});

/** "1.4 GB", "230 MB", "12 KB" */
export function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
