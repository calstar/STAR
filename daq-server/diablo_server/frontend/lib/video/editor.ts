/**
 * The stream editor's working copy (Edit mode on /video), kept apart from the component so
 * the rules are testable: how an id is made from a label, and what a save sends -- above
 * all, that a password the operator did not touch is *omitted*, so the saved one is kept.
 */
import type { CredentialChange, EditableConfig, EditableStream } from './api';

export interface DraftStream {
  /** React key; stable across edits of id. */
  key: string;
  id: string;
  label: string;
  url: string;
  lowResUrl: string;
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
    url: s.url,
    lowResUrl: s.lowResUrl ?? '',
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
    url: '',
    lowResUrl: '',
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

/** What PUT /api/video/config takes. */
export function toSave(drafts: DraftStream[]) {
  const streams = drafts.map((d) => ({
    id: d.id.trim(),
    label: d.label.trim(),
    kind: 'rtsp' as const,
    url: d.url.trim(),
    ...(d.lowResUrl.trim() ? { lowResUrl: d.lowResUrl.trim() } : {}),
    record: d.record,
  }));
  const credentials: Record<string, CredentialChange> = {};
  for (const d of drafts) {
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
    return d.key !== o.key || d.id !== o.id || d.label !== o.label || d.url !== o.url || d.lowResUrl !== o.lowResUrl
      || d.record !== o.record || d.username !== o.username || d.newPassword !== '' || d.clearPassword;
  });
}
