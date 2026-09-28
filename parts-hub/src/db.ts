import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

export type Link = { label: string; url: string };
export type CustomField = { key: string; value: string };
// staged: on this server only · pending: being added to Onshape · ready: in the catalog · failed
export type PartStatus = 'staged' | 'pending' | 'ready' | 'failed';

export interface Part {
  id: number;
  name: string;
  partNumber: string;
  vendor: string;
  category: string;
  tags: string[];
  unitCost: number | null; // USD
  costNote: string;
  description: string;
  notes: string;
  links: Link[];
  customFields: CustomField[];
  thumbnailFile: string | null; // file name under DATA_DIR/thumbs
  originalFilename: string | null;
  originalPath: string | null; // relative to DATA_DIR
  documentId: string | null;
  elementId: string | null;
  versionId: string | null;
  partId: string | null; // unused: inserts always take the whole Part Studio (kept for old rows)
  translationId: string | null;
  status: PartStatus;
  statusDetail: string; // progress text while staged/pending, error message when failed
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  archived: boolean;
}

export interface HistoryEntry {
  id: number;
  partId: number;
  user: string;
  at: string;
  action: string;
  detail: unknown;
}

/** Fields members can edit from the hub. */
export const EDITABLE_FIELDS = [
  'name', 'partNumber', 'vendor', 'category', 'tags', 'unitCost', 'costNote',
  'description', 'notes', 'links', 'customFields',
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];
export type PartEdit = Partial<Pick<Part, EditableField>>;

const COLUMNS: Record<keyof Part, string> = {
  id: 'id',
  name: 'name',
  partNumber: 'part_number',
  vendor: 'vendor',
  category: 'category',
  tags: 'tags',
  unitCost: 'unit_cost_cents',
  costNote: 'cost_note',
  description: 'description',
  notes: 'notes',
  links: 'links',
  customFields: 'custom_fields',
  thumbnailFile: 'thumbnail_file',
  originalFilename: 'original_filename',
  originalPath: 'original_path',
  documentId: 'onshape_document_id',
  elementId: 'onshape_element_id',
  versionId: 'onshape_version_id',
  partId: 'onshape_part_id',
  translationId: 'onshape_translation_id',
  status: 'status',
  statusDetail: 'status_detail',
  createdBy: 'created_by',
  createdAt: 'created_at',
  updatedBy: 'updated_by',
  updatedAt: 'updated_at',
  archived: 'archived',
};
const JSON_FIELDS = new Set<keyof Part>(['tags', 'links', 'customFields']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  part_number TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  unit_cost_cents INTEGER,
  cost_note TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '[]',
  custom_fields TEXT NOT NULL DEFAULT '[]',
  thumbnail_file TEXT,
  original_filename TEXT,
  original_path TEXT,
  onshape_document_id TEXT,
  onshape_element_id TEXT,
  onshape_version_id TEXT,
  onshape_part_id TEXT,
  onshape_translation_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  status_detail TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS parts_element ON parts (onshape_element_id);

CREATE TABLE IF NOT EXISTS part_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id INTEGER NOT NULL REFERENCES parts(id),
  user TEXT NOT NULL,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS part_history_part ON part_history (part_id);

CREATE TABLE IF NOT EXISTS api_usage (
  day TEXT PRIMARY KEY,           -- YYYY-MM-DD (UTC)
  calls INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS panel_sessions (
  id TEXT PRIMARY KEY,            -- sha256 of the handle given to the panel
  tokens TEXT NOT NULL,           -- AES-GCM encrypted {accessToken, refreshToken}
  expires_at INTEGER NOT NULL,    -- access token expiry (ms)
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
`;

export const SYSTEM_USER = 'system';

let db: DatabaseSync;

export function openDb(file = path.join(config.dataDir, 'hub.sqlite')): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not opened');
  return db;
}

const now = () => new Date().toISOString();

function rowToPart(row: Record<string, unknown>): Part {
  const part = {} as Record<string, unknown>;
  for (const [key, col] of Object.entries(COLUMNS) as [keyof Part, string][]) {
    let value = row[col];
    if (JSON_FIELDS.has(key)) value = JSON.parse(String(value ?? '[]'));
    part[key] = value;
  }
  part.archived = Boolean(row.archived);
  part.unitCost = row.unit_cost_cents == null ? null : Number(row.unit_cost_cents) / 100;
  return part as unknown as Part;
}

function toColumnValue(key: keyof Part, value: unknown): string | number | null {
  if (JSON_FIELDS.has(key)) return JSON.stringify(value ?? []);
  if (key === 'unitCost') return value == null ? null : Math.round(Number(value) * 100);
  if (key === 'archived') return value ? 1 : 0;
  return (value ?? null) as string | number | null;
}

export function listParts(opts: { includeArchived?: boolean; onlyReady?: boolean } = {}): Part[] {
  const where: string[] = [];
  if (!opts.includeArchived) where.push('archived = 0');
  if (opts.onlyReady) where.push("status = 'ready'");
  const sql = `SELECT * FROM parts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name COLLATE NOCASE`;
  return getDb().prepare(sql).all().map((r) => rowToPart(r as Record<string, unknown>));
}

export function getPart(id: number): Part | undefined {
  const row = getDb().prepare('SELECT * FROM parts WHERE id = ?').get(id);
  return row ? rowToPart(row as Record<string, unknown>) : undefined;
}

export function knownElementIds(): Set<string> {
  const rows = getDb().prepare('SELECT onshape_element_id AS e FROM parts WHERE onshape_element_id IS NOT NULL').all();
  return new Set(rows.map((r) => String((r as { e: string }).e)));
}

export function createPart(fields: Partial<Part> & { name: string }, user: string): Part {
  const t = now();
  const values: Partial<Part> = { status: 'pending', ...fields, createdBy: user, createdAt: t, updatedBy: user, updatedAt: t };
  const keys = (Object.keys(values) as (keyof Part)[]).filter((k) => k !== 'id');
  const sql = `INSERT INTO parts (${keys.map((k) => COLUMNS[k]).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  const result = getDb().prepare(sql).run(...keys.map((k) => toColumnValue(k, values[k])));
  return getPart(Number(result.lastInsertRowid))!;
}

/** Low-level update (no history). `user` is recorded as last editor when given. */
export function updatePart(id: number, fields: Partial<Part>, user?: string): Part {
  const values: Partial<Part> = { ...fields };
  if (user) {
    values.updatedBy = user;
    values.updatedAt = now();
  }
  const keys = (Object.keys(values) as (keyof Part)[]).filter((k) => k !== 'id');
  if (keys.length) {
    const sql = `UPDATE parts SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`;
    getDb().prepare(sql).run(...keys.map((k) => toColumnValue(k, values[k])), id);
  }
  return getPart(id)!;
}

export function addHistory(partId: number, user: string, action: string, detail?: unknown): void {
  getDb()
    .prepare('INSERT INTO part_history (part_id, user, at, action, detail) VALUES (?, ?, ?, ?, ?)')
    .run(partId, user, now(), action, detail === undefined ? null : JSON.stringify(detail));
}

export function getHistory(partId: number): HistoryEntry[] {
  return getDb()
    .prepare('SELECT * FROM part_history WHERE part_id = ? ORDER BY id DESC')
    .all(partId)
    .map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: Number(row.id),
        partId: Number(row.part_id),
        user: String(row.user),
        at: String(row.at),
        action: String(row.action),
        detail: row.detail ? JSON.parse(String(row.detail)) : null,
      };
    });
}

export function listCategories(): string[] {
  const rows = getDb().prepare("SELECT DISTINCT category FROM parts WHERE category != ''").all();
  const set = new Set([...config.defaultCategories, ...rows.map((r) => String((r as { category: string }).category))]);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Count one Onshape API call (see onApiCall in onshape/client.ts). */
export function recordApiCall(): void {
  getDb()
    .prepare('INSERT INTO api_usage (day, calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1')
    .run(now().slice(0, 10));
}

export function apiCallsSince(day: string): number {
  const row = getDb().prepare('SELECT COALESCE(SUM(calls), 0) AS n FROM api_usage WHERE day >= ?').get(day) as { n: number };
  return Number(row.n);
}
