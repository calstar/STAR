// End-to-end check against real Onshape, using the API keys from the env:
//   1. stage a STEP file like an upload (picture drawn locally), then run "Update Onshape",
//   2. confirm the new Part Studio is in the library document's new version,
//   3. insert it into a test assembly.
// Prints how many Onshape API calls it used.
//
// Usage (on the server):
//   docker compose exec parts-hub node scripts/smoke-test.ts /data/sample.step \
//     https://cad.onshape.com/documents/<did>/w/<wid>/e/<eid>
// or locally:  node --env-file=.env scripts/smoke-test.ts ./sample.step <assembly url>
//
// The hub database is not touched (a throwaway one is used). The Part Studio it
// creates stays in the library document (the hub never deletes Onshape elements):
// delete it in Onshape, or press "Check Onshape for new parts" in the hub to keep it.
// The service account needs edit access to the test assembly's document.
// With MOCK_ONSHAPE=1 it runs against the fake client, to test the script itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [file, assemblyUrl] = process.argv.slice(2);
const m = /\/documents\/([0-9a-f]{24})\/w\/([0-9a-f]{24})\/e\/([0-9a-f]{24})/.exec(assemblyUrl ?? '');
if (!file || !fs.existsSync(file) || !m) {
  console.error('Usage: node scripts/smoke-test.ts <file.step> <https://cad.onshape.com/documents/<did>/w/<wid>/e/<eid> of a test assembly>');
  process.exit(2);
}
const target = { documentId: m[1], workspaceId: m[2], elementId: m[3] };

// Use a scratch DATA_DIR; config is read at import time.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-hub-smoke-'));
process.env.DATA_DIR = scratch;
process.env.SESSION_SECRET ||= 'smoke-test-only-secret';

const { config, validateConfig } = await import('../src/config.ts');
const db = await import('../src/db.ts');
const library = await import('../src/library.ts');
const { createOnshapeClient, onApiCall } = await import('../src/onshape/client.ts');
const { createMockClient } = await import('../src/onshape/mock.ts');

const problems = validateConfig();
if (problems.length) {
  console.error('Configuration problems:\n  - ' + problems.join('\n  - '));
  process.exit(2);
}

const step = (msg: string) => console.log(`\n▶ ${msg}`);
const ok = (msg: string) => console.log(`  ✔ ${msg}`);
let failed = false;
let calls = 0;
onApiCall(() => calls++);

try {
  db.openDb();
  const client = config.mock ? createMockClient() : createOnshapeClient();
  library.initLibrary(client);

  step(`Adding ${path.basename(file)} to the library document ${config.onshape.libraryDocumentId}`);
  const name = `SMOKE TEST ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const part = db.createPart({ name, originalFilename: path.basename(file), status: 'staged' }, 'smoke-test');
  const tmp = path.join(scratch, 'upload');
  fs.copyFileSync(file, tmp);
  db.updatePart(part.id, { originalPath: library.storeOriginal(part.id, tmp, path.basename(file)) });
  await library.renderThumbnail(part.id);
  ok(db.getPart(part.id)!.thumbnailFile ? 'picture drawn on this machine (0 API calls)' : 'could not draw the picture locally; Onshape will');
  const started = Date.now();
  await library.syncToOnshape('smoke-test');
  const result = db.getPart(part.id)!;
  if (result.status !== 'ready') throw new Error(`Update ended as "${result.status}": ${result.statusDetail}`);
  ok(`Part Studio ${result.elementId} in version ${result.versionId} (${Math.round((Date.now() - started) / 1000)} s, ${calls} API calls so far)`);

  step('Checking the library version contains it');
  const studios = await client.listPartStudios('v', result.versionId!);
  const found = studios.find((s) => s.id === result.elementId);
  if (!found) throw new Error('Part Studio not found in the new version');
  ok(`found "${found.name}"`);
  console.log(`  ${config.onshape.baseUrl}/documents/${config.onshape.libraryDocumentId}/v/${result.versionId}/e/${result.elementId}`);

  step(`Inserting into ${assemblyUrl}`);
  await client.insertPartStudio({ kind: 'keys' }, target, { elementId: result.elementId!, versionId: result.versionId! });
  ok('inserted (at the assembly origin)');
  console.log(`\nOnshape API calls used: ${calls}`);
  console.log(`\nPASS. Remember to delete "${name}" from the library document if you don't want to keep it.`);
} catch (err) {
  failed = true;
  console.error(`\nFAIL: ${err instanceof Error ? err.message : err}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
