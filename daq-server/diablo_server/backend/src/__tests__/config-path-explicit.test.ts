/**
 * An explicit CONFIG_PATH is the only config the backend touches, even before the file exists.
 *
 * The backend used to fall back to the checkout's own config/config.toml whenever CONFIG_PATH
 * named a file not yet written. A test that pointed CONFIG_PATH at a fresh temp directory then
 * read, and created profiles beside, the developer's real config: `config/profiles/cold_flow/`
 * and `taken/` appeared in the checkout after `npm test` on any machine with a deployed config.
 *
 * Here a decoy config sits where the fallback would look (cwd/../../config/config.toml); the
 * named one is missing but has a profile to generate from. The backend must generate the named
 * one and leave the decoy alone.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// realpath: on macOS the temp dir is a symlink, and cwd comes back resolved.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'daq-cfgpath-')));
const decoy = join(root, 'config', 'config.toml');
const cwd = join(root, 'a', 'b');
const named = join(root, 'isolated', 'config', 'config.toml');

mkdirSync(join(root, 'config'), { recursive: true });
writeFileSync(decoy, '# decoy: the checkout config a test must never touch\n');
mkdirSync(cwd, { recursive: true });
mkdirSync(join(root, 'isolated', 'config', 'profiles', 'default'), { recursive: true });
writeFileSync(
  join(root, 'isolated', 'config', 'profiles', 'default', 'config.toml'),
  '[network]\nactuator_cmd_port = 5005\n',
);

const before = process.cwd();
process.chdir(cwd);
process.env.CONFIG_PATH = named;
const { getConfigPath } = await import('../routes/config.js');

afterAll(() => {
  process.chdir(before);
  rmSync(root, { recursive: true, force: true });
});

describe('getConfigPath with CONFIG_PATH set', () => {
  it('generates the named config and never falls back to the checkout one', () => {
    const got = getConfigPath();
    expect(got, 'fell back to the checkout config').not.toBe(decoy);
    expect(got).toBe(named);
    expect(readFileSync(named, 'utf-8')).toContain('actuator_cmd_port = 5005');
  });
});
