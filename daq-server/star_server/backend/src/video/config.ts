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
  /** Zoom to fill the tile, cropping what overhangs, instead of letterboxing. For cameras
   *  whose aspect ratio wastes the slot. Off by default: letterboxing never hides an edge. */
  fill?: boolean;
}

/**
 * MPEG-TS pushed to the gateway over UDP -- the HiDes link: HiDesViewer (or `hides
 * rx-stream --udp`) on the receiver Mac forwards the UT-130's transport stream here. No URL
 * and no credentials: the gateway listens on `port`, on every interface.
 */
export interface UdpStream {
  id: string;
  label: string;
  kind: 'udp';
  /** In UDP_PORTS: clear of the DAQ's own UDP (5000, 5005, 5006, 5008), opened by bootstrap. */
  port: number;
  record: boolean;
  /** As RtspStream.fill. */
  fill?: boolean;
}

export type VideoStream = RtspStream | UdpStream;

/** UDP ports a pushed stream may listen on. bootstrap_daq.sh opens exactly this range. */
export const UDP_PORTS = { first: 5600, last: 5609 } as const;

/**
 * The stand layout: a preset and which stream each of its slots shows (null = empty).
 * 'auto' has no slots of its own -- every stream, in list order, on an even grid.
 * Slot counts live here; the geometry (which slot is the large one, where each sits) is
 * the frontend's (lib/video/layout.ts), and a test holds the two counts together.
 */
export const LAYOUT_PRESETS = { auto: 0, '1x1': 1, '2x2': 4, '3x3': 9, '1+5': 6, '1+7': 8 } as const;
export type LayoutPreset = keyof typeof LAYOUT_PRESETS;

export interface VideoLayout {
  preset: LayoutPreset;
  slots: (string | null)[];
}

export const AUTO_LAYOUT: VideoLayout = { preset: 'auto', slots: [] };

/** The disk guard, enforced by the video agent on the gateway machine (ticket 09). */
export interface RecordingSettings {
  /** Record is refused with less than this free. */
  refuseBelowGB: number;
  /** A recording stops cleanly at this much free. */
  stopBelowGB: number;
}

export const DEFAULT_RECORDING: RecordingSettings = { refuseBelowGB: 20, stopBelowGB: 5 };

export interface VideoConfig {
  version: 1;
  streams: VideoStream[];
  layout: VideoLayout;
  recording: RecordingSettings;
}

/** A layout slot that shows the recording controls instead of a stream (not a stream id:
 *  ids cannot start with "@"). */
export const CONTROLS_SLOT = '@controls';

export interface StreamSecret {
  username?: string;
  password?: string;
}

/** Where this machine's backend finds the gateway (default: this machine), and the
 *  password the gateway was given (scripts/video-gateway.sh --set-password). */
export interface GatewaySetting {
  host?: string;
  password?: string;
}

/** The machine-local file: camera credentials, and this machine's gateway setting. */
export interface VideoSecrets {
  streams: Record<string, StreamSecret>;
  gateway?: GatewaySetting;
}

/** A hostname (theombp.local), an IPv4 address, or localhost. Ports are fixed by mediamtx.yml. */
export const GATEWAY_HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;

/** What a browser may see of a stream. Deliberately has no URL field. */
export interface PublicStream {
  id: string;
  label: string;
  kind: VideoStream['kind'];
  hasLowRes: boolean;
  record: boolean;
  /** Zoom to fill the tile instead of letterboxing. */
  fill: boolean;
}

export const STREAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function videoConfigPath(): string {
  return process.env.VIDEO_CONFIG_PATH || join(dirname(getConfigPath()), 'video.json');
}

export function videoSecretsPath(): string {
  return process.env.VIDEO_SECRETS_PATH || join(dirname(videoConfigPath()), 'video.secrets.json');
}

export const EMPTY_CONFIG: VideoConfig = { version: 1, streams: [], layout: AUTO_LAYOUT, recording: { refuseBelowGB: 20, stopBelowGB: 5 } };

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
 * Validate a layout against the streams that exist. An unknown preset is an error (and reads
 * as 'auto'); a slot naming a stream that no longer exists is simply empty -- removing a
 * stream empties its slots, it does not break the layout.
 */
export function validateLayout(raw: unknown, streamIds: Set<string>): { layout: VideoLayout; errors: string[] } {
  if (raw === undefined || raw === null) return { layout: { ...AUTO_LAYOUT, slots: [] }, errors: [] };
  const r = raw as Record<string, unknown>;
  if (typeof r !== 'object' || typeof r.preset !== 'string' || !(r.preset in LAYOUT_PRESETS)) {
    return { layout: { ...AUTO_LAYOUT, slots: [] }, errors: [`unknown layout preset ${JSON.stringify(r?.preset)}`] };
  }
  const preset = r.preset as LayoutPreset;
  const n = LAYOUT_PRESETS[preset];
  const given = Array.isArray(r.slots) ? r.slots : [];
  const slots = Array.from({ length: n }, (_, i) => {
    const v = given[i];
    return typeof v === 'string' && (streamIds.has(v) || v === CONTROLS_SLOT) ? v : null;
  });
  return { layout: { preset, slots }, errors: [] };
}

/**
 * Validate a parsed video.json. Returns the streams that are well-formed and an error per
 * problem; a malformed stream is dropped rather than poisoning the rest, so one typo does
 * not black out every tile.
 */
export function validateVideoConfig(raw: unknown): { config: VideoConfig; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { config: { ...EMPTY_CONFIG, streams: [], layout: { ...AUTO_LAYOUT, slots: [] }, recording: { ...DEFAULT_RECORDING } }, errors: ['video config is not a JSON object'] };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) errors.push(`unsupported video config version ${String(obj.version)}`);
  const list = Array.isArray(obj.streams) ? obj.streams : [];
  if (!Array.isArray(obj.streams)) errors.push('streams must be a list');

  const seen = new Set<string>();
  const udpPorts = new Set<number>();
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
    if (s.fill !== undefined && typeof s.fill !== 'boolean') errors.push(`${where}: fill must be true or false`);
    const fill = s.fill === true ? { fill: true } : {};
    if (s.kind === 'udp') {
      const port = s.port;
      if (!Number.isInteger(port) || port < UDP_PORTS.first || port > UDP_PORTS.last) {
        errors.push(`${where}: UDP port must be ${UDP_PORTS.first}-${UDP_PORTS.last}`);
      } else if (udpPorts.has(port)) {
        errors.push(`${where}: UDP port ${port} is already used by another stream`);
      }
      if (errors.length > before) return;
      seen.add(s.id);
      udpPorts.add(port);
      streams.push({ id: s.id, label: s.label.trim(), kind: 'udp', port, record: s.record !== false, ...fill });
      return;
    }
    if (s.kind !== 'rtsp') errors.push(`${where}: kind must be "rtsp" or "udp"`);
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
      ...fill,
    });
  });
  const l = validateLayout(obj.layout, new Set(streams.map((s) => s.id)));
  errors.push(...l.errors);
  const recording = { ...DEFAULT_RECORDING };
  const r = obj.recording as Record<string, unknown> | undefined;
  if (r && typeof r === 'object') {
    for (const k of ['refuseBelowGB', 'stopBelowGB'] as const) {
      if (r[k] === undefined) continue;
      if (typeof r[k] === 'number' && (r[k] as number) >= 0) recording[k] = r[k] as number;
      else errors.push(`recording.${k} must be a number of GB`);
    }
    if (recording.stopBelowGB > recording.refuseBelowGB) errors.push('recording.stopBelowGB is above refuseBelowGB: a recording would stop as soon as it started');
  }
  return { config: { version: 1, streams, layout: l.layout, recording }, errors };
}

export function validateVideoSecrets(raw: unknown): { secrets: VideoSecrets; errors: string[] } {
  const errors: string[] = [];
  const secrets: VideoSecrets = { streams: {} };
  if (!raw || typeof raw !== 'object') return { secrets, errors: ['video secrets file is not a JSON object'] };
  const g = (raw as any).gateway;
  if (g && typeof g === 'object') {
    const gateway: GatewaySetting = {};
    if (typeof g.host === 'string' && GATEWAY_HOST_RE.test(g.host)) gateway.host = g.host;
    else if (g.host !== undefined && g.host !== '') errors.push('video secrets: gateway host is not a hostname or address');
    if (typeof g.password === 'string' && g.password) gateway.password = g.password;
    if (gateway.host || gateway.password) secrets.gateway = gateway;
  }
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
  const vc = c.value === undefined ? { config: { ...EMPTY_CONFIG, streams: [], layout: { ...AUTO_LAYOUT, slots: [] }, recording: { ...DEFAULT_RECORDING } }, errors: [] } : validateVideoConfig(c.value);
  errors.push(...vc.errors);
  const s = readJson(videoSecretsPath());
  // Never echo the secrets file's contents: a parse error says the file is bad, not what is in it.
  if (s.error) errors.push('video secrets file is not valid JSON');
  const vs = s.value === undefined ? { secrets: { streams: {} }, errors: [] } : validateVideoSecrets(s.value);
  errors.push(...vs.errors);
  return { config: vc.config, secrets: vs.secrets, errors };
}

export function publicStream(s: VideoStream): PublicStream {
  return { id: s.id, label: s.label, kind: s.kind, hasLowRes: s.kind === 'rtsp' && !!s.lowResUrl, record: s.record, fill: !!s.fill };
}

// ── Editing (the pane's Edit mode) ─────────────────────────────────────────────

/** A stream as the editor sees it: URLs (never with credentials), the username, and only
 *  *whether* a password is set. A password is write-only: it is never sent back. */
export type EditableStream = VideoStream & {
  username: string;
  passwordSet: boolean;
};

export interface EditableConfig {
  /** Hash of video.json as read; a save must name it, so two editors cannot silently
   *  overwrite each other. */
  revision: string;
  streams: EditableStream[];
  layout: VideoLayout;
  /** This machine's gateway: host ('' = this machine) and whether a password is saved. */
  gateway: { host: string; passwordSet: boolean };
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
    layout: config.layout,
    gateway: { host: secrets.gateway?.host ?? '', passwordSet: !!secrets.gateway?.password },
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
  input: { streams: unknown; layout?: unknown; credentials?: Record<string, CredentialChange>; gateway?: CredentialChange & { host?: string } },
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
  // No layout in the request keeps the saved one (re-checked against the new stream list).
  let currentLayout: unknown;
  try { currentLayout = currentText ? JSON.parse(currentText).layout : undefined; } catch { currentLayout = undefined; }
  const l = validateLayout(input.layout === undefined ? currentLayout : input.layout, new Set(config.streams.map((s) => s.id)));
  if (input.layout !== undefined && l.errors.length) throw new VideoConfigError(400, l.errors);

  let current: Record<string, unknown> = {};
  try { current = currentText ? JSON.parse(currentText) : {}; } catch { current = {}; }
  const { secrets } = loadVideoConfig();

  // This machine's gateway: host ('' = this machine), password write-only like a camera's.
  const nextGateway: GatewaySetting = { ...secrets.gateway };
  const gw = input.gateway;
  if (gw && typeof gw.host === 'string') {
    const host = gw.host.trim();
    if (host && !GATEWAY_HOST_RE.test(host)) throw new VideoConfigError(400, [`gateway "${host}" is not a hostname or address`]);
    if (host) nextGateway.host = host; else delete nextGateway.host;
  }
  if (gw?.password === null || gw?.password === '') delete nextGateway.password;
  else if (typeof gw?.password === 'string') nextGateway.password = gw.password;

  const nextSecrets: VideoSecrets = { streams: {}, ...(nextGateway.host || nextGateway.password ? { gateway: nextGateway } : {}) };
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

  writeAtomic(configPath, JSON.stringify({ ...current, version: 1, streams: config.streams, layout: l.layout }, null, 2) + '\n');
  writeAtomic(videoSecretsPath(), JSON.stringify(nextSecrets, null, 2) + '\n', 0o600);
  return editableConfig();
}
