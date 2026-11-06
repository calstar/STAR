/**
 * The stream editor's working copy (Edit mode on /video), kept apart from the component so
 * the rules are testable: how an id is made from a label, and what a save sends -- above
 * all, that a password the operator did not touch is *omitted*, so the saved one is kept.
 */
import { UDP_PORTS, type CredentialChange, type EditableConfig, type EditableStream } from './api';
import { PRESET_SLOT_COUNTS, type LayoutPreset, type VideoLayout } from './layout';

export interface DraftStream {
  /** React key; stable across edits of id. */
  key: string;
  id: string;
  label: string;
  /** rtsp: a camera the gateway pulls. udp: MPEG-TS pushed to the gateway (HiDes). */
  kind: 'rtsp' | 'udp';
  url: string;
  lowResUrl: string;
  /** UDP listen port, as typed (udp only). */
  port: string;
  record: boolean;
  username: string;
  /** A password is saved on the server for this stream (as loaded). */
  passwordSet: boolean;
  /** Typed in this session; '' = untouched. */
  newPassword: string;
  /** Operator asked to remove the saved password. */
  clearPassword: boolean;
  /** Not yet saved: its id is still editable (and follows the label until edited). */
  isNew: boolean;
  /** The operator typed the id themselves. */
  idEdited: boolean;
}

let seq = 0;
const nextKey = () => `d${++seq}`;

export function draftsFrom(cfg: EditableConfig): DraftStream[] {
  return cfg.streams.map((s: EditableStream) => ({
    key: nextKey(),
    id: s.id,
    label: s.label,
    kind: s.kind,
    url: s.kind === 'rtsp' ? s.url : '',
    lowResUrl: s.kind === 'rtsp' ? s.lowResUrl ?? '' : '',
    port: s.kind === 'udp' ? String(s.port) : '',
    record: s.record,
    username: s.username,
    passwordSet: s.passwordSet,
    newPassword: '',
    clearPassword: false,
    isNew: false,
    idEdited: false,
  }));
}

/** A stream id from a label: lowercase letters, digits and dashes, unique among `taken`. */
export function slugId(label: string, taken: Iterable<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'stream';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function newDraft(existing: DraftStream[]): DraftStream {
  return {
    key: nextKey(),
    id: slugId('stream', existing.map((d) => d.id)),
    label: '',
    kind: 'rtsp',
    url: '',
    lowResUrl: '',
    port: '',
    record: true,
    username: '',
    passwordSet: false,
    newPassword: '',
    clearPassword: false,
    isNew: true,
    idEdited: false,
  };
}

/** Apply a label edit: a new stream's id follows its label until the id is edited. */
export function withLabel(drafts: DraftStream[], key: string, label: string): DraftStream[] {
  return drafts.map((d) => {
    if (d.key !== key) return d;
    if (!d.isNew || d.idEdited) return { ...d, label };
    return { ...d, label, id: slugId(label, drafts.filter((o) => o.key !== key).map((o) => o.id)) };
  });
}

/** The first UDP port in the video range no other draft uses ('' if all are taken). */
export function freeUdpPort(drafts: DraftStream[], except?: string): string {
  const used = new Set(drafts.filter((d) => d.kind === 'udp' && d.key !== except).map((d) => d.port));
  for (let p = UDP_PORTS.first; p <= UDP_PORTS.last; p++) if (!used.has(String(p))) return String(p);
  return '';
}

/** Switch a draft between a pulled camera and a pushed (UDP) stream. */
export function withKind(drafts: DraftStream[], key: string, kind: 'rtsp' | 'udp'): DraftStream[] {
  return drafts.map((d) => (d.key !== key || d.kind === kind ? d
    : { ...d, kind, port: kind === 'udp' && !d.port ? freeUdpPort(drafts, key) : d.port }));
}

/** What PUT /api/video/config takes. A pushed stream sends no URL and no credentials. */
export function toSave(drafts: DraftStream[]) {
  const streams = drafts.map((d) => (d.kind === 'udp'
    ? { id: d.id.trim(), label: d.label.trim(), kind: 'udp' as const, port: Number(d.port), record: d.record }
    : {
      id: d.id.trim(),
      label: d.label.trim(),
      kind: 'rtsp' as const,
      url: d.url.trim(),
      ...(d.lowResUrl.trim() ? { lowResUrl: d.lowResUrl.trim() } : {}),
      record: d.record,
    }));
  const credentials: Record<string, CredentialChange> = {};
  for (const d of drafts) {
    if (d.kind === 'udp') continue;
    const c: CredentialChange = { username: d.username.trim() };
    if (d.newPassword) c.password = d.newPassword;
    else if (d.clearPassword) c.password = null;
    // else: omitted -> the server keeps the saved password
    credentials[d.id.trim()] = c;
  }
  return { streams, credentials };
}

/** Has the operator changed anything since `original` was loaded? */
export function isDirty(drafts: DraftStream[], original: DraftStream[]): boolean {
  if (drafts.length !== original.length) return true;
  return drafts.some((d, i) => {
    const o = original[i];
    return d.key !== o.key || d.id !== o.id || d.label !== o.label || d.kind !== o.kind || d.port !== o.port
      || d.url !== o.url || d.lowResUrl !== o.lowResUrl
      || d.record !== o.record || d.username !== o.username || d.newPassword !== '' || d.clearPassword;
  });
}

// ── Layout ───────────────────────────────────────────────────────────────────
// In the editor a slot holds a draft's *key*, not its id: a new stream's id follows its
// label as it is typed, and the slot must follow the stream, not the half-typed id.

export function draftLayoutFrom(layout: VideoLayout, drafts: DraftStream[]): VideoLayout {
  const keyOf = new Map(drafts.map((d) => [d.id, d.key]));
  return { preset: layout.preset, slots: layout.slots.map((id) => (id ? keyOf.get(id) ?? null : null)) };
}

/** The editor's layout as the server takes it: keys -> current ids; gone -> empty. */
export function layoutIds(layout: VideoLayout, drafts: DraftStream[]): VideoLayout {
  const idOf = new Map(drafts.map((d) => [d.key, d.id.trim()]));
  return { preset: layout.preset, slots: layout.slots.map((k) => (k ? idOf.get(k) ?? null : null)) };
}

/** Switch preset, keeping the slots that still fit. */
export function withPreset(layout: VideoLayout, preset: LayoutPreset): VideoLayout {
  const n = PRESET_SLOT_COUNTS[preset];
  return { preset, slots: Array.from({ length: n }, (_, i) => layout.slots[i] ?? null) };
}
