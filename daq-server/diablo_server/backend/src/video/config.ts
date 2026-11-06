/**
 * VIDCOMM stream config: what the video pane shows and the gateway pulls.
 *
 *   config/video.json          tracked: stream ids, labels, URLs, flags (and, later, layout)
 *   config/video.secrets.json  gitignored, per machine: camera credentials
 *
 * Credentials never live in video.json -- a URL with a user:pass@ part is rejected, so a
 * password cannot be committed by pasting a camera URL -- and never leave the backend: the
 * browser gets `PublicStream`, which has no URL at all. The gateway is the only thing that
 * ever sees a camera URL with its credentials in it (see gateway.ts `cameraSource`).
 */
import { readFileSync, existsSync, writeFileSync, renameSync, chmodSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { getConfigPath } from '../routes/config.js';

export interface RtspStream {
  /** Stable id: names the gateway path (`raw/<id>`) and the API route. */
  id: string;
  /** What operators read on the tile, e.g. "Engine close-up". */
  label: string;
  kind: 'rtsp';
  /** Main stream, without credentials. */
  url: string;
  /** Optional sub stream for small tiles (ticket 04). */
  lowResUrl?: string;
  /** Include in the rolling buffer and recordings (tickets 08, 09). */
  record: boolean;
}

export type VideoStream = RtspStream;

export interface VideoConfig {
  version: 1;
  streams: VideoStream[];
}

export interface StreamSecret {
  username?: string;
  password?: string;
}

export interface VideoSecrets {
  streams: Record<string, StreamSecret>;
}

/** What a browser may see of a stream. Deliberately has no URL field. */
export interface PublicStream {
  id: string;
  label: string;
  kind: VideoStream['kind'];
  hasLowRes: boolean;
  record: boolean;
}

export const STREAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function videoConfigPath(): string {
  return process.env.VIDEO_CONFIG_PATH || join(dirname(getConfigPath()), 'video.json');
}

export function videoSecretsPath(): string {
  return process.env.VIDEO_SECRETS_PATH || join(dirname(videoConfigPath()), 'video.secrets.json');
}

export const EMPTY_CONFIG: VideoConfig = { version: 1, streams: [] };

export function checkRtspUrl(value: unknown, field: string, errors: string[]): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${field} is required`);
    return undefined;
  }
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    errors.push(`${field} is not a URL`);
    return undefined;
  }
  if (u.protocol !== 'rtsp:' && u.protocol !== 'rtsps:') {
    errors.push(`${field} must start with rtsp:// or rtsps://`);
    return undefined;
  }
  if (u.username || u.password) {
    errors.push(`${field} has credentials in it; put them in the secrets file instead`);
    return undefined;
  }
  if (!u.hostname) {
    errors.push(`${field} has no host`);
    return undefined;
  }
  return value;
}

/**
 * Validate a parsed video.json. Returns the streams that are well-formed and an error per
 * problem; a malformed stream is dropped rather than poisoning the rest, so one typo does
 * not black out every tile.
 */
export function validateVideoConfig(raw: unknown): { config: VideoConfig; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { config: { ...EMPTY_CONFIG, streams: [] }, errors: ['video config is not a JSON object'] };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) errors.push(`unsupported video config version ${String(obj.version)}`);
  const list = Array.isArray(obj.streams) ? obj.streams : [];
  if (!Array.isArray(obj.streams)) errors.push('streams must be a list');

  const seen = new Set<string>();
  const streams: VideoStream[] = [];
  list.forEach((s: any, i) => {
    const where = `stream ${i + 1}${s && typeof s.id === 'string' ? ` ("${s.id}")` : ''}`;
    const before = errors.length;
    if (!s || typeof s !== 'object') {
      errors.push(`${where} is not an object`);
      return;
    }
    if (typeof s.id !== 'string' || !STREAM_ID_RE.test(s.id)) {
      errors.push(`${where}: id must be lowercase letters, digits and dashes (max 32)`);
    } else if (seen.has(s.id)) {
      errors.push(`${where}: duplicate id`);
    }
    if (typeof s.label !== 'string' || s.label.trim() === '') errors.push(`${where}: label is required`);
    if (s.kind !== 'rtsp') errors.push(`${where}: kind must be "rtsp"`);
    const url = checkRtspUrl(s.url, `${where}: url`, errors);
    const lowResUrl = s.lowResUrl === undefined || s.lowResUrl === '' ? undefined : checkRtspUrl(s.lowResUrl, `${where}: lowResUrl`, errors);
    if (errors.length > before || !url) return;
    seen.add(s.id);
    streams.push({
      id: s.id,
      label: s.label.trim(),
      kind: 'rtsp',
      url,
      ...(lowResUrl ? { lowResUrl } : {}),
      record: s.record !== false,
    });
  });
  return { config: { version: 1, streams }, errors };
}

export function validateVideoSecrets(raw: unknown): { secrets: VideoSecrets; errors: string[] } {
  const errors: string[] = [];
  const secrets: VideoSecrets = { streams: {} };
  if (!raw || typeof raw !== 'object') return { secrets, errors: ['video secrets file is not a JSON object'] };
  const streams = (raw as any).streams;
  if (streams === undefined) return { secrets, errors };
  if (!streams || typeof streams !== 'object' || Array.isArray(streams)) {
    return { secrets, errors: ['video secrets: streams must be an object keyed by stream id'] };
  }
  for (const [id, v] of Object.entries(streams as Record<string, any>)) {
    if (!v || typeof v !== 'object') continue;
    const s: StreamSecret = {};
    if (typeof v.username === 'string' && v.username) s.username = v.username;
    if (typeof v.password === 'string' && v.password) s.password = v.password;
    secrets.streams[id] = s;
  }
  return { secrets, errors };
}

function readJson(path: string): { value: unknown; error?: string } {
  if (!existsSync(path)) return { value: undefined };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    return { value: undefined, error: `${path}: ${(e as Error).message}` };
  }
}

export interface LoadedVideoConfig {
  config: VideoConfig;
  secrets: VideoSecrets;
  errors: string[];
}

/** Read both files. A missing file is an empty config, not an error. */
export function loadVideoConfig(): LoadedVideoConfig {
  const errors: string[] = [];
  const c = readJson(videoConfigPath());
  if (c.error) errors.push(c.error);
  const vc = c.value === undefined ? { config: { ...EMPTY_CONFIG, streams: [] }, errors: [] } : validateVideoConfig(c.value);
  errors.push(...vc.errors);
  const s = readJson(videoSecretsPath());
  // Never echo the secrets file's contents: a parse error says the file is bad, not what is in it.
  if (s.error) errors.push('video secrets file is not valid JSON');
  const vs = s.value === undefined ? { secrets: { streams: {} }, errors: [] } : validateVideoSecrets(s.value);
  errors.push(...vs.errors);
  return { config: vc.config, secrets: vs.secrets, errors };
}

export function publicStream(s: VideoStream): PublicStream {
  return { id: s.id, label: s.label, kind: s.kind, hasLowRes: !!s.lowResUrl, record: s.record };
}

// ── Editing (the pane's Edit mode) ─────────────────────────────────────────────

/** A stream as the editor sees it: URLs (never with credentials), the username, and only
 *  *whether* a password is set. A password is write-only: it is never sent back. */
export interface EditableStream extends VideoStream {
  username: string;
  passwordSet: boolean;
}

export interface EditableConfig {
  /** Hash of video.json as read; a save must name it, so two editors cannot silently
   *  overwrite each other. */
  revision: string;
  streams: EditableStream[];
}

/** Per-stream credential change. username: set ('' clears). password: undefined keeps the
 *  saved one, null or '' clears it, a string sets it. */
export interface CredentialChange {
  username?: string;
  password?: string | null;
}

export class VideoConfigError extends Error {
  constructor(readonly status: number, readonly errors: string[]) {
    super(errors.join('; '));
  }
}

function fileText(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

export function revisionOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function editableConfig(): EditableConfig {
  const { config, secrets } = loadVideoConfig();
  return {
    revision: revisionOf(fileText(videoConfigPath())),
    streams: config.streams.map((s) => ({
      ...s,
      username: secrets.streams[s.id]?.username ?? '',
      passwordSet: !!secrets.streams[s.id]?.password,
    })),
  };
}

/** Write via a temp file and rename, so a crash mid-write never leaves half a config. */
function writeAtomic(path: string, text: string, mode?: number): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/**
 * Save the editor's stream list. All-or-nothing: an invalid stream rejects the whole save
 * (400) and nothing is written; a stale `baseRevision` is a 409. Keys of video.json other
 * than `streams` (the layout, later) are kept as they are. Secrets for removed streams are
 * dropped with them.
 */
export function saveVideoConfig(
  input: { streams: unknown; credentials?: Record<string, CredentialChange> },
  baseRevision: string,
): EditableConfig {
  const configPath = videoConfigPath();
  const currentText = fileText(configPath);
  if (baseRevision !== revisionOf(currentText)) {
    throw new VideoConfigError(409, ['The video config changed since you opened Edit. Cancel and edit again.']);
  }
  const { config, errors } = validateVideoConfig({ version: 1, streams: input.streams });
  // Validation drops bad streams; a save must not silently lose one, so any error rejects it.
  if (errors.length) throw new VideoConfigError(400, errors);

  let current: Record<string, unknown> = {};
  try { current = currentText ? JSON.parse(currentText) : {}; } catch { current = {}; }
  const { secrets } = loadVideoConfig();

  const nextSecrets: VideoSecrets = { streams: {} };
  for (const s of config.streams) {
    const prev = secrets.streams[s.id] ?? {};
    const change = input.credentials?.[s.id] ?? {};
    const next: StreamSecret = { ...prev };
    if (typeof change.username === 'string') {
      if (change.username) next.username = change.username; else delete next.username;
    }
    if (change.password === null || change.password === '') delete next.password;
    else if (typeof change.password === 'string') next.password = change.password;
    if (next.username || next.password) nextSecrets.streams[s.id] = next;
  }

  writeAtomic(configPath, JSON.stringify({ ...current, version: 1, streams: config.streams }, null, 2) + '\n');
  writeAtomic(videoSecretsPath(), JSON.stringify(nextSecrets, null, 2) + '\n', 0o600);
  return editableConfig();
}
