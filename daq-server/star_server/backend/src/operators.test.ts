import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the loader at a scratch roster before importing it (the path is read at
// module load). Then exercise parsing, case-insensitivity, mtime reload, and the
// fail-closed behavior when the file is missing.
const tmp = path.join(os.tmpdir(), `daq-operators-test-${process.pid}.txt`);
process.env.DAQ_OPERATORS_FILE = tmp;

const { isOperator } = await import('./operators.js');

function writeRoster(contents: string, atMsFromNow = 0): void {
  fs.writeFileSync(tmp, contents);
  if (atMsFromNow) {
    const t = new Date(Date.now() + atMsFromNow);
    fs.utimesSync(tmp, t, t); // force a distinct mtime so the cache reloads
  }
}

describe('DAQ operators allowlist', () => {
  it('matches case-insensitively and ignores comments/blanks', () => {
    writeRoster('# ops\nAlice@Berkeley.EDU\n\n# comment\nbob@berkeley.edu\n');
    expect(isOperator('alice@berkeley.edu')).toBe(true);
    expect(isOperator('BOB@BERKELEY.EDU')).toBe(true);
    expect(isOperator('carol@berkeley.edu')).toBe(false);
    expect(isOperator('')).toBe(false);
  });

  it('reloads when the file changes (mtime)', () => {
    writeRoster('carol@berkeley.edu\n', 2000);
    expect(isOperator('carol@berkeley.edu')).toBe(true);
    expect(isOperator('alice@berkeley.edu')).toBe(false);
  });

  it('denies everyone when the file is missing (fail-closed)', () => {
    fs.rmSync(tmp, { force: true });
    expect(isOperator('carol@berkeley.edu')).toBe(false);
  });
});
