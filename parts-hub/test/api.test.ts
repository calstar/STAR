// End-to-end API tests against the mock Onshape client: `npm test`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-hub-test-'));
const adminsFile = path.join(dataDir, 'admins.txt');
fs.writeFileSync(adminsFile, '# test admins\nBoss@Berkeley.edu\n');
Object.assign(process.env, {
  PARTS_ADMINS_FILE: adminsFile,
  MOCK_ONSHAPE: '1',
  AUTH_MODE: 'header',
  ALLOWED_EMAIL_DOMAINS: 'berkeley.edu',
  DATA_DIR: dataDir,
  SESSION_SECRET: 'test-secret-test-secret',
});

let server: Server;
let base = '';
const member = { 'x-auth-email': 'Oski@Berkeley.edu' };
const ids = { documentId: 'a'.repeat(24), workspaceId: 'b'.repeat(24), elementId: 'c'.repeat(24) };
// A real STEP file (ships with occt-import-js) so the local renderer is exercised too.
const CUBE = fs.readFileSync(path.join(import.meta.dirname, '../node_modules/occt-import-js/test/testfiles/rounded-cube/rounded-cube.step'));

async function upload(name: string, filename: string, extra: object = {}) {
  const form = new FormData();
  form.set('meta', JSON.stringify({ name, ...extra }));
  form.set('file', new Blob([CUBE]), filename);
  return (await hub('parts', { method: 'POST', body: form })).json();
}

async function syncAndWait() {
  const res = await hub('sync', { method: 'POST' });
  assert.equal(res.status, 202);
  return waitFor(async () => {
    const s = await (await hub('sync')).json();
    return s.job.running ? undefined : s;
  });
}

before(async () => {
  // Config is read at import time, so import after the env is set.
  const { openDb } = await import('../src/db.ts');
  const { initLibrary } = await import('../src/library.ts');
  const { createMockClient } = await import('../src/onshape/mock.ts');
  const { createApp } = await import('../src/app.ts');
  openDb();
  initLibrary(createMockClient());
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const hub = (p: string, init: RequestInit = {}) =>
  fetch(`${base}/api/hub/${p}`, { ...init, headers: { ...member, ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...init.headers } });

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out');
}

async function panelSession(): Promise<string> {
  const res = await fetch(`${base}/panel/oauth/start?documentId=${ids.documentId}&evil=1`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const location = res.headers.get('location')!;
  assert.ok(!location.includes('evil'), 'only Onshape action-URL params survive the round trip');
  return /#session=(.+)$/.exec(location)![1];
}

test('hub requires a school identity from the proxy', async () => {
  assert.equal((await fetch(`${base}/api/hub/parts`)).status, 401);
  assert.equal((await fetch(`${base}/api/hub/parts`, { headers: { 'x-auth-email': 'someone@gmail.com' } })).status, 401);
  assert.equal((await fetch(`${base}/`)).status, 401);
  const me = await (await hub('me')).json();
  assert.equal(me.email, 'oski@berkeley.edu');
});

test('panel routes skip school login but need an Onshape session', async () => {
  assert.equal((await fetch(`${base}/panel/`)).status, 200);
  assert.equal((await fetch(`${base}/panel/api/catalog`)).status, 401);
  assert.equal((await fetch(`${base}/panel/api/catalog`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  // A school-login header does not get you into the panel API.
  assert.equal((await fetch(`${base}/panel/api/catalog`, { headers: member })).status, 401);
  const csp = (await fetch(`${base}/panel/`)).headers.get('content-security-policy') ?? '';
  assert.match(csp, /frame-ancestors [^;]*onshape\.com/);
});

test('upload stays on the server until "Update Onshape", then reaches the panel', async () => {
  const created = await upload('1/4 Tube Union SS', 'union.step', {
    partNumber: 'SS-400-6', vendor: 'Swagelok', unitCost: '21.40',
    links: [{ label: '', url: 'swagelok.com' }], customFields: [{ key: 'Material', value: '316 SS' }],
  });
  assert.equal(created.status, 'staged');
  assert.equal(created.createdBy, 'oski@berkeley.edu');
  assert.deepEqual(created.links, [{ label: 'swagelok.com', url: 'https://swagelok.com/' }]);

  // The picture is drawn on the server from the STEP file.
  const drawn = await waitFor(async () => {
    const p = await (await hub(`parts/${created.id}`)).json();
    return p.thumbUrl && !p.rendering ? p : undefined;
  });
  const png = await fetch(base + drawn.thumbUrl);
  assert.equal(png.status, 200, 'thumbnails are served outside the login gate');
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(drawn.elementId, null, 'nothing sent to Onshape yet');

  const second = await upload('Second part', 'second.stp');
  const before = await (await hub('sync')).json();
  assert.equal(before.waiting, 2);
  const synced = await syncAndWait();
  assert.equal(synced.job.result.added, 2);
  assert.equal(synced.waiting, 0);
  const [a, b] = await Promise.all([created.id, second.id].map(async (id) => (await hub(`parts/${id}`)).json()));
  assert.equal(a.status, 'ready');
  assert.ok(a.elementId && a.versionId);
  assert.equal(a.versionId, b.versionId, 'one version for the whole batch');
  const named = (globalThis as { __mockPartNames?: Map<string, string> }).__mockPartNames!;
  assert.equal(named.get(a.elementId), '1/4 Tube Union SS', 'parts in Onshape are named after the hub name');

  const session = await panelSession();
  const auth = { authorization: `Bearer ${session}` };
  const catalog = await (await fetch(`${base}/panel/api/catalog`, { headers: auth })).json();
  const entry = catalog.find((p: { id: number }) => p.id === created.id);
  assert.equal(entry.name, '1/4 Tube Union SS');
  assert.equal(entry.elementId, undefined, 'panel never sees Onshape internals');

  const insert = (body: object) =>
    fetch(`${base}/panel/api/insert`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await insert({ partId: created.id, ...ids })).status, 200);
  assert.equal((await insert({ partId: created.id, ...ids, workspaceId: '../x' })).status, 400);
  // Onshape refusing (e.g. library shared without Link) is a 4xx with an explanation,
  // never a 5xx that Cloudflare would swap for its own error page.
  const refused = await insert({ partId: created.id, ...ids, documentId: 'd'.repeat(24) });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /Link permission/);

  // Archived parts disappear from the panel and can't be inserted.
  await hub(`parts/${created.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: true }) });
  const remaining = await (await fetch(`${base}/panel/api/catalog`, { headers: auth })).json();
  assert.ok(!remaining.some((p: { id: number }) => p.id === created.id));
  assert.equal((await insert({ partId: created.id, ...ids })).status, 404);
});

test('edits are validated and recorded in history', async () => {
  const { id } = await upload('Edit me', 'edit.stp');

  assert.equal((await hub(`parts/${id}`, { method: 'PATCH', body: JSON.stringify({ name: ' ' }) })).status, 400);
  assert.equal((await hub(`parts/${id}`, { method: 'PATCH', body: JSON.stringify({ links: [{ url: 'javascript:alert(1)' }] }) })).status, 400);
  const res = await hub(`parts/${id}`, { method: 'PATCH', body: JSON.stringify({ vendor: 'Parker', tags: 'a, b, a' }) });
  const part = await res.json();
  assert.deepEqual(part.tags, ['a', 'b']);
  const { history } = await (await hub(`parts/${id}`)).json();
  assert.equal(history[0].action, 'Edited');
  assert.deepEqual(history[0].detail.vendor, { from: '', to: 'Parker' });
});

test('a part Onshape cannot translate fails alone and can be retried', async () => {
  const { id } = await upload('Broken', 'will-fail.step');
  const { id: fine } = await upload('Fine', 'fine.step');
  const sync = await syncAndWait();
  assert.equal(sync.job.result.failed, 1);
  const failed = await (await hub(`parts/${id}`)).json();
  assert.equal(failed.status, 'failed');
  assert.match(failed.statusDetail, /could not translate/i);
  assert.equal((await (await hub(`parts/${fine}`)).json()).status, 'ready', 'the rest of the batch still goes through');
  const retried = await (await hub(`parts/${id}/retry`, { method: 'POST' })).json();
  assert.equal(retried.status, 'staged');
  assert.equal((await hub('sync', { method: 'POST' })).status, 202);
  await syncAndWait();
});

test('an update with nothing waiting is refused', async () => {
  // (the retried part above failed again and is not waiting)
  assert.equal((await hub('sync', { method: 'POST' })).status, 400);
});

test('"Check Onshape for new parts" lists Part Studios added directly in Onshape', async () => {
  await hub('check-onshape', { method: 'POST' });
  const job = await waitFor(async () => {
    const j = await (await hub('check-onshape')).json();
    return j.running ? undefined : j;
  });
  assert.equal(job.result.created, 3, 'the three Part Studios only Onshape knew about');
  const found = (await (await hub('parts')).json()).filter((p: { createdBy: string; name: string }) => p.name === '3/8 Tee SS');
  assert.equal(found.length, 1);
  assert.equal(found[0].status, 'ready');
  // Running it again finds nothing new.
  await hub('check-onshape', { method: 'POST' });
  const again = await waitFor(async () => {
    const j = await (await hub('check-onshape')).json();
    return j.running ? undefined : j;
  });
  assert.equal(again.result.created, 0);
});

const admin = { 'x-auth-email': 'boss@berkeley.edu' };
const asAdmin = (p: string, init: RequestInit = {}) => hub(p, { ...init, headers: { ...admin, ...(init.headers as object) } });

test('only admins may replace a file or delete a part', async () => {
  assert.equal((await (await hub('me')).json()).isAdmin, false);
  assert.equal((await (await asAdmin('me')).json()).isAdmin, true, 'admins.txt is case-insensitive');
  const { id } = await upload('Protected', 'p.step');
  const form = new FormData();
  form.set('file', new Blob([CUBE]), 'new.step');
  assert.equal((await hub(`parts/${id}/file`, { method: 'POST', body: form })).status, 403);
  assert.equal((await hub(`parts/${id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await (await hub(`parts/${id}`)).json()).name, 'Protected');
});

test('an admin replacing the file sends it to Onshape again; the old Part Studio is never re-listed', async () => {
  const { id } = await upload('Replace me', 'old.step', { vendor: 'Keep', unitCost: 5 });
  await syncAndWait();
  const before = await (await hub(`parts/${id}`)).json();
  assert.ok(before.elementId);

  const form = new FormData();
  form.set('file', new Blob([CUBE]), 'new-rev-b.step');
  const res = await asAdmin(`parts/${id}/file`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const replaced = await res.json();
  assert.equal(replaced.status, 'staged');
  assert.equal(replaced.originalFilename, 'new-rev-b.step');
  assert.equal(replaced.elementId, null);
  assert.equal(replaced.vendor, 'Keep', 'details are kept');
  assert.equal((await (await hub(`parts/${id}`)).json()).history[0].action, 'Replaced the CAD file');

  await syncAndWait();
  const after = await (await hub(`parts/${id}`)).json();
  assert.equal(after.status, 'ready');
  assert.notEqual(after.elementId, before.elementId, 'a fresh Part Studio');

  // The old Part Studio is still in (mock) Onshape but must not come back as a new part.
  await hub('check-onshape', { method: 'POST' });
  const check = await waitFor(async () => {
    const j = await (await hub('check-onshape')).json();
    return j.running ? undefined : j;
  });
  assert.equal(check.result.created, 0);
});

test('an admin can delete a part for good', async () => {
  const { id } = await upload('Delete me', 'gone.step');
  await waitFor(async () => {
    const p = await (await hub(`parts/${id}`)).json();
    return p.rendering === false ? p : undefined;
  });
  assert.ok(fs.existsSync(path.join(dataDir, 'originals', String(id))));
  assert.equal((await asAdmin(`parts/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await hub(`parts/${id}`)).status, 404);
  assert.ok(!fs.existsSync(path.join(dataDir, 'originals', String(id))), 'uploaded file removed');
  assert.ok(!(await (await hub('parts?archived=1')).json()).some((p: { id: number }) => p.id === id));
});

const masses = () => (globalThis as { __mockMasses?: Map<string, number> }).__mockMasses!;

test('weights go to Onshape as mass, in kg, and a later change re-versions the part', async () => {
  assert.equal((await hub('parts/1', { method: 'PATCH', body: JSON.stringify({ weight: -1 }) })).status, 400);
  assert.equal((await hub('parts/1', { method: 'PATCH', body: JSON.stringify({ weightUnit: 'stone' }) })).status, 400);

  const { id } = await upload('Heavy union', 'heavy.step', { weight: '2', weightUnit: 'oz' });
  await syncAndWait();
  const first = await (await hub(`parts/${id}`)).json();
  assert.equal(first.status, 'ready');
  assert.ok(Math.abs(masses().get(first.elementId)! - 2 * 0.028349523125) < 1e-12, '2 oz in kg');

  // Changing the weight of a part already in Onshape waits for the next update...
  const edited = await (await hub(`parts/${id}`, { method: 'PATCH', body: JSON.stringify({ weight: 0.25, weightUnit: 'lb' }) })).json();
  assert.equal(edited.weightDirty, true);
  assert.equal(edited.status, 'ready', 'still insertable meanwhile');
  assert.equal((await (await hub('sync')).json()).weightChanges, 1);

  // ...which writes it and gives the part a new version to insert from.
  const sync = await syncAndWait();
  assert.equal(sync.job.result.weightsUpdated, 1);
  const after = await (await hub(`parts/${id}`)).json();
  assert.equal(after.weightDirty, false);
  assert.notEqual(after.versionId, first.versionId);
  assert.ok(Math.abs(masses().get(after.elementId)! - 0.25 * 0.45359237) < 1e-12);
  assert.equal((await (await hub('sync')).json()).weightChanges, 0);
});
