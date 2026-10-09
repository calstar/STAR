// Consistent snapshot of the hub database while the app is running.
//   docker compose exec parts-hub node scripts/backup.ts
// writes DATA_DIR/backups/hub-<timestamp>.sqlite and prints its path. Back up that
// file together with DATA_DIR/originals and DATA_DIR/thumbs (see README).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const dir = path.join(dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `hub-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);

const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'), { readOnly: true });
db.prepare('VACUUM INTO ?').run(out);
db.close();
console.log(out);
