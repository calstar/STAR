// Uploads stay on this server (with a locally rendered picture) until someone
// presses "Update Onshape". Then every waiting part goes to Onshape in one batch
// that shares a single library version, keeping API calls to roughly one per part.
//
// Everything that touches Onshape goes through one in-process queue, so batches
// never race each other on translations or versions.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { addHistory, createPart, deletePartRow, WEIGHT_UNITS, getPart, knownElementIds, listParts, retireElement, SYSTEM_USER, updatePart, type Part } from './db.ts';
import type { OnshapeClient, TranslationState } from './onshape/client.ts';
import { canRenderLocally, renderLocally } from './render/index.ts';

const POLL_TIMEOUT_MS = 20 * 60 * 1000;
export const WAITING = 'Waiting for the next "Update Onshape"';

let client: OnshapeClient;
let tail: Promise<unknown> = Promise.resolve();

export function initLibrary(c: OnshapeClient): void {
  client = c;
  for (const dir of ['originals', 'thumbs', 'tmp']) fs.mkdirSync(path.join(config.dataDir, dir), { recursive: true });
  for (const part of listParts({ includeArchived: true })) {
    // An update cut short by a restart: the next update picks up where it stopped.
    if (part.status === 'pending') updatePart(part.id, { status: 'staged', statusDetail: WAITING });
    if (part.status === 'staged' && !part.thumbnailFile) void renderThumbnail(part.id);
  }
}

export function onshape(): OnshapeClient {
  return client;
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job);
  tail = run.catch(() => {});
  return run;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const extOf = (filename: string) => filename.toLowerCase().split('.').pop() ?? '';

/** Move an uploaded temp file into DATA_DIR/originals/<partId>/ and return its DATA_DIR-relative path. */
export function storeOriginal(partId: number, tmpPath: string, filename: string): string {
  const safe = path.basename(filename).replace(/[^\w.\- ()]/g, '_') || 'upload';
  const rel = path.join('originals', String(partId), safe);
  fs.mkdirSync(path.join(config.dataDir, 'originals', String(partId)), { recursive: true });
  fs.renameSync(tmpPath, path.join(config.dataDir, rel));
  return rel;
}

// ---- thumbnails ------------------------------------------------------------------

const rendering = new Set<number>();
export const isRendering = (partId: number) => rendering.has(partId);

function writeThumbnail(partId: number, data: Buffer, ext: string): void {
  const part = getPart(partId)!;
  // The random suffix makes the URL unguessable and lets browsers cache it forever.
  const file = `${partId}-${crypto.randomBytes(12).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(config.dataDir, 'thumbs', file), data);
  if (part.thumbnailFile) fs.rmSync(path.join(config.dataDir, 'thumbs', part.thumbnailFile), { force: true });
  updatePart(partId, { thumbnailFile: file });
}

/**
 * Draw the picture from the uploaded file on this server (no Onshape calls).
 * Formats we can't read get their picture from Onshape during the next update.
 */
export async function renderThumbnail(partId: number): Promise<void> {
  const part = getPart(partId);
  if (!part?.originalPath || !canRenderLocally(part.originalFilename ?? part.originalPath)) return;
  rendering.add(partId);
  try {
    const png = await renderLocally(path.join(config.dataDir, part.originalPath), part.originalFilename ?? part.originalPath);
    // The part may have been deleted, or its file replaced, while this was drawing.
    if (getPart(partId)?.originalPath !== part.originalPath) return;
    writeThumbnail(partId, png, 'png');
  } catch (err) {
    if (!getPart(partId)) return;
    addHistory(partId, SYSTEM_USER, 'Picture could not be drawn from the file', {
      error: errorMessage(err),
      note: 'Onshape will draw it during the next update',
    });
  } finally {
    rendering.delete(partId);
  }
}

async function onshapeThumbnail(partId: number): Promise<void> {
  const part = getPart(partId)!;
  const image = await client.renderThumbnail(part.versionId!, part.elementId!); // 1 API call
  writeThumbnail(partId, image.data, image.ext);
}

/** Redraw locally when we have a readable original, otherwise ask Onshape (1 API call). */
export function refreshThumbnail(partId: number): Promise<void> {
  const part = getPart(partId)!;
  if (part.originalPath && canRenderLocally(part.originalFilename ?? part.originalPath)) return renderThumbnail(partId);
  if (!part.versionId || !part.elementId) return Promise.resolve();
  return enqueue(() => onshapeThumbnail(partId));
}

// ---- Update Onshape (batch) ------------------------------------------------------

/** Parts that the next update will send to Onshape. */
export function waitingParts(): Part[] {
  return listParts().filter((p) => p.status === 'staged' || p.status === 'pending');
}

/** Parts already in Onshape whose weight changed since; the next update re-versions them. */
export function weightChanges(): Part[] {
  return listParts().filter((p) => p.status === 'ready' && p.weightDirty && p.elementId);
}

const massKg = (p: Part) => (p.weight == null ? null : p.weight * WEIGHT_UNITS[p.weightUnit]);

/** Rough API cost of updating now, shown next to the button. */
export function estimateCalls(parts = waitingParts(), weights = weightChanges()): number {
  if (!parts.length && !weights.length) return 0;
  const imports = parts.filter((p) => !p.elementId && !p.translationId).length;
  const pictures = parts.filter((p) => !p.thumbnailFile && !isRendering(p.id)).length;
  const importing = parts.length ? 3 /* status checks */ + 1 /* find the new tabs */ : 0;
  return imports + importing + 2 /* names + weights */ + 1 /* version */ + pictures;
}

export type SyncResult = { added: number; failed: number; weightsUpdated: number; versionId: string | null };
export type SyncJob = { running: boolean; startedBy?: string; parts?: number; step?: string; result?: SyncResult; error?: string };
let job: SyncJob = { running: false };
export const syncStatus = () => job;

/** Start an update in the background (no-op if one is running). */
export function startSync(user: string): SyncJob {
  if (!job.running) void syncToOnshape(user).catch(() => {});
  return job;
}

export function syncToOnshape(user: string): Promise<SyncResult> {
  job = { running: true, startedBy: user, parts: waitingParts().length + weightChanges().length, step: 'Queued' };
  return enqueue(() => runSync(user)).then(
    (result) => {
      job = { running: false, startedBy: user, result };
      return result;
    },
    (err) => {
      job = { running: false, startedBy: user, error: errorMessage(err) };
      throw err;
    },
  );
}

/** Onshape names the new tab after the file, so send the display name as the file name. */
function onshapeFilename(part: Part): string {
  const name = part.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'part';
  return `${name}.${extOf(part.originalFilename ?? part.originalPath ?? 'step')}`;
}

async function runSync(user: string): Promise<SyncResult> {
  const batch = waitingParts().map((p) => p.id);
  const reweigh = weightChanges().map((p) => p.id);
  if (!batch.length && !reweigh.length) return { added: 0, failed: 0, weightsUpdated: 0, versionId: null };
  const step = (s: string) => (job = { ...job, step: s });
  const current = () => batch.map((id) => getPart(id)!).filter((p) => p.status === 'pending');
  const fail = (id: number, msg: string, retranslate = false) => {
    updatePart(id, { status: 'failed', statusDetail: msg, ...(retranslate ? { translationId: null } : {}) });
    addHistory(id, SYSTEM_USER, 'Onshape update failed', { error: msg });
  };
  for (const id of batch) updatePart(id, { status: 'pending', statusDetail: 'Sending to Onshape' });

  try {
    // 1. Start one import per new file (1 call each). They translate in parallel on Onshape's side.
    step('Sending files to Onshape');
    for (const part of current()) {
      if (part.elementId || part.translationId) continue;
      if (!part.originalPath) {
        fail(part.id, 'No original file on the server');
        continue;
      }
      try {
        const translationId = await client.startImport(path.join(config.dataDir, part.originalPath), onshapeFilename(part));
        updatePart(part.id, { translationId, documentId: config.onshape.libraryDocumentId, statusDetail: 'Translating in Onshape' });
      } catch (err) {
        fail(part.id, errorMessage(err));
      }
    }

    // 2. Wait for all of them together, then find their Part Studio tabs in one call.
    const translating = current().filter((p) => p.translationId && !p.elementId);
    if (translating.length) {
      step(`Waiting for Onshape to translate ${translating.length} file(s)`);
      const states = await waitForTranslations(translating.map((p) => p.translationId!));
      const anyDone = translating.some((p) => states.get(p.translationId!)?.state === 'DONE');
      const studios = anyDone
        ? new Set((await client.listPartStudios('w', await client.libraryWorkspaceId())).map((s) => s.id))
        : new Set<string>();
      for (const part of translating) {
        const state = states.get(part.translationId!);
        if (!state) fail(part.id, 'Timed out waiting for Onshape to translate the file');
        else if (state.state === 'FAILED') fail(part.id, `Onshape could not translate the file: ${state.failureReason || 'unknown reason'}`, true);
        else {
          const elementId = state.resultElementIds.find((id) => studios.has(id));
          if (elementId) updatePart(part.id, { elementId });
          else fail(part.id, 'The import produced no Part Studio (is the file empty or only surfaces?)', true);
        }
      }
    }

    // 3. Name the new parts after the hub name (vendor files carry names like "Mirror 1",
    //    which is what assemblies show) and write every weight as the parts' mass, in one
    //    batch (2 calls). Then one version for the whole batch: that's what the panel
    //    inserts from, so weight changes on parts already in Onshape need it too.
    const unversioned = current().filter((p) => p.elementId && !p.versionId);
    const reweighed = reweigh.map((id) => getPart(id)).filter((p): p is Part => Boolean(p?.weightDirty && p.elementId));
    let versionId: string | null = null;
    let propsOk = true;
    if (unversioned.length || reweighed.length) {
      step('Naming parts and setting weights');
      propsOk = await setPartProperties([
        // New parts without a weight leave Onshape's mass alone; a cleared weight clears it.
        ...unversioned.map((p) => ({ id: p.id, elementId: p.elementId!, name: p.name, massKg: massKg(p) ?? undefined })),
        ...reweighed.map((p) => ({ id: p.id, elementId: p.elementId!, massKg: massKg(p) })),
      ]);
      // If Onshape refused the weights, leave those parts waiting rather than version them unchanged.
      if (!propsOk) reweighed.length = 0;
    }
    if (unversioned.length || reweighed.length) {
      step('Creating a library version');
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const what = [
        unversioned.length ? `${unversioned.length} part(s) added` : '',
        reweighed.length ? `${reweighed.length} weight(s) updated` : '',
      ].filter(Boolean).join(', ');
      versionId = await client.createVersion(
        `Parts Hub update ${stamp}`,
        `${what} by ${user}: ${[...unversioned, ...reweighed].map((p) => p.name).join(', ')}`.slice(0, 5000),
      );
      // A weight Onshape refused stays waiting for the next update.
      for (const part of unversioned) updatePart(part.id, { versionId, weightDirty: !propsOk && part.weight != null });
      for (const part of reweighed) {
        updatePart(part.id, { versionId, weightDirty: false });
        addHistory(part.id, user, 'Weight sent to Onshape', { weight: `${part.weight ?? '-'} ${part.weightUnit}`, versionId });
      }
    }

    // 4. Pictures only for files we couldn't draw ourselves (1 call each), then done.
    step('Finishing');
    let added = 0;
    for (const part of current()) {
      if (!part.versionId) continue;
      if (!part.thumbnailFile) {
        try {
          await onshapeThumbnail(part.id);
        } catch (err) {
          addHistory(part.id, SYSTEM_USER, 'Thumbnail failed', { error: errorMessage(err) });
        }
      }
      updatePart(part.id, { status: 'ready', statusDetail: '' });
      addHistory(part.id, user, 'Added to Onshape', { versionId: part.versionId, elementId: part.elementId });
      added++;
    }
    return { added, failed: batch.length - added, weightsUpdated: reweighed.length, versionId };
  } catch (err) {
    // Anything that stopped the whole batch (network, version creation...). Parts keep
    // whatever step they reached, so the next update resumes instead of re-importing.
    for (const part of current()) fail(part.id, errorMessage(err));
    throw err;
  }
}

async function waitForTranslations(ids: string[]): Promise<Map<string, TranslationState>> {
  // Every status check is a billable API call and STEP files take tens of seconds to
  // translate, so check rarely: at ~8 s, 19 s, 35 s, 58 s, then every 30 s.
  const settled = new Map<string, TranslationState>();
  const started = Date.now();
  let delay = 8000;
  while (settled.size < ids.length && Date.now() - started < POLL_TIMEOUT_MS) {
    await sleep(config.mock ? 300 : delay);
    const pending = ids.filter((id) => !settled.has(id));
    for (const [id, state] of await client.getTranslations(pending)) if (state.state !== 'ACTIVE') settled.set(id, state);
    delay = Math.min(delay * 1.4, 30000);
  }
  return settled;
}

/** Set part names/masses; a failure is noted on the parts but never stops the update. */
async function setPartProperties(studios: { id: number | null; elementId: string; name?: string; massKg?: number | null }[]): Promise<boolean> {
  try {
    await client.setPartProperties(studios);
    return true;
  } catch (err) {
    for (const s of studios) {
      if (s.id) addHistory(s.id, SYSTEM_USER, 'Could not set part names/weight in Onshape', { error: errorMessage(err) });
    }
    console.error('[library] setting part properties failed:', err);
    return false;
  }
}

export class Busy extends Error {}

/**
 * Admin: swap a part's CAD file. The new file is stored and drawn here, and the part
 * waits for the next "Update Onshape", which imports it as a fresh Part Studio. The
 * old Part Studio stays in Onshape (assemblies may use it) but the hub stops pointing
 * at it. Metadata (name, cost, links...) is kept.
 */
export function replaceOriginal(partId: number, tmpPath: string, filename: string, user: string): Part {
  const part = getPart(partId)!;
  if (part.status === 'pending') throw new Busy('This part is being added to Onshape right now. Try again when that finishes.');
  const oldPath = part.originalPath;
  const originalPath = storeOriginal(partId, tmpPath, filename);
  if (oldPath && oldPath !== originalPath) fs.rmSync(path.join(config.dataDir, oldPath), { force: true });
  if (part.elementId) retireElement(part.elementId, partId);
  const updated = updatePart(
    partId,
    { originalPath, originalFilename: filename, translationId: null, elementId: null, versionId: null, partId: null, status: 'staged', statusDetail: WAITING },
    user,
  );
  addHistory(partId, user, 'Replaced the CAD file', { file: filename, was: part.originalFilename, oldElementId: part.elementId });
  void renderThumbnail(partId);
  return updated;
}

/**
 * Admin: delete a part from the hub for good (record, history, file, picture). Its Part
 * Studio stays in the Onshape library, since assemblies may use it, but is never listed again.
 */
export function deletePart(partId: number): void {
  const part = getPart(partId)!;
  if (part.status === 'pending') throw new Busy('This part is being added to Onshape right now. Try again when that finishes.');
  if (part.elementId) retireElement(part.elementId, partId);
  deletePartRow(partId);
  if (part.originalPath) fs.rmSync(path.join(config.dataDir, 'originals', String(partId)), { recursive: true, force: true });
  if (part.thumbnailFile) fs.rmSync(path.join(config.dataDir, 'thumbs', part.thumbnailFile), { force: true });
}

/** Put a failed part back in line for the next update. */
export function retryPart(partId: number): void {
  updatePart(partId, { status: 'staged', statusDetail: WAITING });
}

const CAD_SUFFIX = /\.(step|stp|iges|igs|sldprt|sldasm|x_t|x_b|sat|jt|catpart|catproduct|prt|asm|ipt|iam|par|psm|3dm|stl|obj|3mf)$/i;
// Every new Onshape document starts with an empty "Part Studio 1"; don't list those.
const DEFAULT_TAB = /^Part Studio \d+$/;

/**
 * "Check Onshape for new parts": find Part Studios someone added straight to the
 * library document in Onshape (importing there is free), give them one shared
 * version, fetch their pictures and list them in the hub.
 * Costs ~5 calls plus 1 per new part (its picture).
 */
export function checkOnshape(user: string): Promise<{ created: number; versionId: string | null }> {
  return enqueue(async () => {
    const studios = await client.listPartStudios('w', await client.libraryWorkspaceId());
    const known = knownElementIds();
    const fresh = studios.filter((s) => !known.has(s.id) && !DEFAULT_TAB.test(s.name));
    if (!fresh.length) return { created: 0, versionId: null };

    await setPartProperties(fresh.map((s) => ({ id: null, elementId: s.id, name: s.name.replace(CAD_SUFFIX, '').trim() || s.name })));
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const versionId = await client.createVersion(
      `Parts Hub check ${stamp}`,
      `${fresh.length} part(s) found by ${user}: ${fresh.map((s) => s.name).join(', ')}`.slice(0, 5000),
    );
    for (const studio of fresh) {
      const part = createPart(
        {
          name: studio.name.replace(CAD_SUFFIX, '').trim() || studio.name,
          documentId: config.onshape.libraryDocumentId,
          elementId: studio.id,
          versionId,
          status: 'ready',
        },
        user,
      );
      addHistory(part.id, user, 'Found in the Onshape library document', { elementId: studio.id, versionId });
      try {
        await onshapeThumbnail(part.id);
      } catch (err) {
        addHistory(part.id, SYSTEM_USER, 'Thumbnail failed', { error: errorMessage(err) });
      }
    }
    return { created: fresh.length, versionId };
  });
}
