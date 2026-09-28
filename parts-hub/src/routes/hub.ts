// Hub API: behind school login. Any signed-in member may upload, edit and archive.
import fs from 'node:fs';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { config } from '../config.ts';
import { addHistory, apiCallsSince, createPart, getHistory, getPart, listCategories, listParts, updatePart, type Part } from '../db.ts';
import { checkOnshape, estimateCalls, refreshThumbnail, renderThumbnail, retryPart, startSync, storeOriginal, syncStatus, WAITING, waitingParts } from '../library.ts';
import { BadRequest, CAD_EXTENSIONS, cleanEdit, hubJson } from '../parts.ts';

export const hubApi = Router();

const upload = multer({
  dest: path.join(config.dataDir, 'tmp'),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
});

const user = (req: Request) => req.user!.email;

function findPart(req: Request): Part {
  const part = getPart(Number(req.params.id));
  if (!part) throw new NotFound('Part not found');
  return part;
}
class NotFound extends Error {}

hubApi.get('/me', (req, res) => {
  const now = new Date();
  res.json({
    ...req.user,
    mock: config.mock,
    libraryDocumentUrl: `${config.onshape.baseUrl}/documents/${config.onshape.libraryDocumentId}`,
    apiCalls: {
      last30Days: apiCallsSince(new Date(now.getTime() - 30 * 864e5).toISOString().slice(0, 10)),
      thisYear: apiCallsSince(`${now.getUTCFullYear()}-01-01`),
    },
  });
});

hubApi.get('/categories', (_req, res) => {
  res.json(listCategories());
});

hubApi.get('/parts', (req, res) => {
  res.json(listParts({ includeArchived: req.query.archived === '1' }).map(hubJson));
});

hubApi.get('/parts/:id', (req, res) => {
  const part = findPart(req);
  res.json({ ...hubJson(part), history: getHistory(part.id) });
});

// Upload: multipart with `file` (the CAD model) and `meta` (JSON of the editable fields).
hubApi.post('/parts', upload.single('file'), (req, res) => {
  const file = req.file;
  try {
    if (!file) throw new BadRequest('Attach a CAD file');
    // multer decodes the filename as latin1; browsers send UTF-8.
    const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    if (!CAD_EXTENSIONS.includes(ext)) throw new BadRequest(`.${ext} files can't be imported by Onshape`);
    const meta = cleanEdit(JSON.parse(String(req.body.meta ?? '{}')));
    if (!meta.name) throw new BadRequest('Display name is required');

    // Stays on this server until someone presses "Update Onshape"; the picture is drawn here.
    const part = createPart({ ...meta, name: meta.name, originalFilename: filename, status: 'staged', statusDetail: WAITING }, user(req));
    updatePart(part.id, { originalPath: storeOriginal(part.id, file.path, filename) });
    addHistory(part.id, user(req), 'Created', { file: filename });
    void renderThumbnail(part.id);
    res.status(201).json(hubJson(getPart(part.id)!));
  } finally {
    if (file && fs.existsSync(file.path)) fs.rmSync(file.path, { force: true });
  }
});

hubApi.patch('/parts/:id', (req, res) => {
  const part = findPart(req);
  const edit = cleanEdit(req.body ?? {});
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, value] of Object.entries(edit)) {
    const before = part[key as keyof Part];
    if (JSON.stringify(before) !== JSON.stringify(value)) changes[key] = { from: before, to: value };
  }
  if (!Object.keys(changes).length) {
    res.json(hubJson(part));
    return;
  }
  // Hub-only: the catalog shows the hub's name, so nothing is sent to Onshape.
  const updated = updatePart(part.id, edit, user(req));
  addHistory(part.id, user(req), 'Edited', changes);
  res.json(hubJson(updated));
});

hubApi.post('/parts/:id/archive', (req, res) => {
  const part = findPart(req);
  const archived = req.body?.archived !== false;
  const updated = updatePart(part.id, { archived }, user(req));
  addHistory(part.id, user(req), archived ? 'Archived' : 'Restored');
  res.json(hubJson(updated));
});

hubApi.post('/parts/:id/retry', (req, res) => {
  const part = findPart(req);
  if (part.status !== 'failed') throw new BadRequest('Only failed parts can be retried');
  retryPart(part.id);
  addHistory(part.id, user(req), 'Queued for the next Onshape update');
  res.json(hubJson(getPart(part.id)!));
});

hubApi.post('/parts/:id/refresh-thumbnail', async (req, res) => {
  const part = findPart(req);
  await refreshThumbnail(part.id);
  res.json(hubJson(getPart(part.id)!));
});

hubApi.get('/parts/:id/original', (req, res) => {
  const part = findPart(req);
  if (!part.originalPath) throw new NotFound('No original file for this part');
  res.download(path.join(config.dataDir, part.originalPath), part.originalFilename ?? path.basename(part.originalPath));
});

// "Update Onshape": send every waiting part in one batch (runs in the background).
hubApi.get('/sync', (_req, res) => {
  const waiting = waitingParts();
  res.json({ job: syncStatus(), waiting: waiting.length, estimatedCalls: estimateCalls(waiting) });
});

hubApi.post('/sync', (req, res) => {
  if (!waitingParts().length && !syncStatus().running) throw new BadRequest('No parts are waiting for Onshape');
  res.status(202).json({ job: startSync(user(req)) });
});

// "Check Onshape for new parts" runs in the background (a picture per new part) and
// the parts list polls its status.
let checkJob: { running: boolean; startedBy?: string; result?: unknown; error?: string } = { running: false };

hubApi.get('/check-onshape', (_req, res) => {
  res.json(checkJob);
});

hubApi.post('/check-onshape', (req, res) => {
  if (!checkJob.running) {
    checkJob = { running: true, startedBy: user(req) };
    checkOnshape(user(req)).then(
      (result) => (checkJob = { running: false, result }),
      (err) => (checkJob = { running: false, error: err instanceof Error ? err.message : String(err) }),
    );
  }
  res.status(202).json(checkJob);
});

hubApi.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof BadRequest || err instanceof SyntaxError) res.status(400).json({ error: err.message });
  else if (err instanceof NotFound) res.status(404).json({ error: err.message });
  else if (err instanceof multer.MulterError) res.status(400).json({ error: err.message });
  else {
    console.error('[hub]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server error' });
  }
});
