import { config, validateConfig } from './config.ts';
import { openDb, recordApiCall } from './db.ts';
import { initLibrary } from './library.ts';
import { createOnshapeClient, onApiCall } from './onshape/client.ts';
import { createMockClient } from './onshape/mock.ts';
import { createApp } from './app.ts';
import { seedMockParts } from './seed.ts';

const problems = validateConfig();
if (problems.length) {
  console.error('Configuration problems:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
if (config.auth.mode === 'dev') console.warn(`[auth] AUTH_MODE=dev: everyone is ${config.auth.devUserEmail}. Never use this on the server.`);

openDb();
onApiCall(recordApiCall);
initLibrary(config.mock ? createMockClient() : createOnshapeClient());
if (config.mock) seedMockParts();

createApp().listen(config.port, () => {
  console.log(`STAR Parts Hub listening on :${config.port} (${config.mock ? 'MOCK Onshape' : 'Onshape'}; data in ${config.dataDir})`);
  console.log(`  hub:   ${config.publicBaseUrl}/`);
  console.log(`  panel: ${config.publicBaseUrl}/panel/`);
});
