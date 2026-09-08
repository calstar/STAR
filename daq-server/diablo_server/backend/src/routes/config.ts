/**
 * Config file management routes
 * Handles reading and writing config.toml
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { applyControllerDefaults } from '../controller-config.js';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_PATH = process.env.CONFIG_PATH ||
  join(process.cwd(), '..', 'config', 'config.toml');

export function getConfigPath(): string {
  // Try multiple possible paths
  const possiblePaths = [
    CONFIG_PATH,
    join(process.cwd(), '..', '..', 'config', 'config.toml'),
    // __dirname resolves relative to the compiled JS — walk up to project root
    join(__dirname, '..', '..', '..', '..', 'config', 'config.toml'),
  ];

  for (const path of possiblePaths) {
    try {
      readFileSync(path, 'utf-8');
      return path;
    } catch {
      continue;
    }
  }

  // config.toml is a generated runtime artifact (git-ignored). If it doesn't exist yet — a fresh
  // checkout that hasn't deployed a profile — self-heal by materializing it from the ACTIVE profile
  // (config/.active_profile → config/profiles/<name>.toml), falling back to default.toml. Respecting
  // the active profile matters on a deployed server: a missing config.toml must regenerate as that
  // box's real config, not the repo default. Keeps the backend + every C++ service working with no
  // manual bootstrap step.
  for (const path of possiblePaths) {
    const dir = dirname(path);
    let activeName = 'default';
    try {
      const a = readFileSync(join(dir, '.active_profile'), 'utf-8').trim();
      if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(a)) activeName = a;
    } catch { /* no pointer → default */ }
    // Profiles are directories (config-profiles v3): profiles/<name>/config.toml, with the
    // profile's CSVs beside it. Legacy flat profiles/<name>.toml is still accepted so a
    // half-migrated box can still bootstrap.
    const candidates = [
      join(dir, 'profiles', activeName, 'config.toml'),
      join(dir, 'profiles', 'default', 'config.toml'),
      join(dir, 'profiles', `${activeName}.toml`),
      join(dir, 'profiles', 'default.toml'),
    ];
    for (const src of candidates) {
      if (existsSync(src)) {
        try {
          copyFileSync(src, path);
          readFileSync(path, 'utf-8');
          console.log(`🌱 Generated config.toml from ${src}`);
          // The state-machine CSVs deploy alongside config.toml; materialize any that are missing
          // so the C++ services (which read config/*.csv by hardcoded path) work on a fresh box.
          try {
            const srcDir = dirname(src);
            if (srcDir !== join(dir, 'profiles')) {
              for (const f of readdirSync(srcDir).filter((n) => n.endsWith('.csv'))) {
                const target = join(dir, f);
                if (!existsSync(target)) copyFileSync(join(srcDir, f), target);
              }
            }
          } catch { /* CSVs are best-effort — config.toml is what this function promises */ }
          return path;
        } catch { /* try next */ }
      }
    }
  }

  throw new Error('Config file not found (and no config/profiles/*.toml to generate it from)');
}

/**
 * Default every PT sensor's calibration model when the config omits it. For each [boards.*] of type
 * 'PT', ensure a parallel `calibration_model_<boardKey>` map exists with an entry for every role in
 * `sensor_roles_<boardKey>`. The default is interface-aware: current-loop 4-20 mA boards default to
 * 'physics' (their historical hardwired conversion), all other PT boards to 'cubic'. All three
 * models (cubic/robust/physics) are valid on any PT board. Mutates config in place on read (mirrors
 * applyControllerDefaults) so the editor and any reader see a model for sensors the file leaves unset.
 */
export function applyCalibrationModelDefaults(config: any): void {
  const boards = config?.boards;
  if (!boards || typeof boards !== 'object') return;
  for (const [boardKey, b] of Object.entries<any>(boards)) {
    if (!b || b.type !== 'PT') continue;
    const isLoop =
      b.hp_pt_connectors || b.hp_pt_full_scale_psi != null || b.pt_type === '4-20 mA absolute';
    const roles = config[`sensor_roles_${boardKey}`];
    if (!roles || typeof roles !== 'object') continue;
    const modelKey = `calibration_model_${boardKey}`;
    const models =
      config[modelKey] && typeof config[modelKey] === 'object' ? config[modelKey] : {};
    for (const role of Object.keys(roles)) {
      if (models[role] == null) models[role] = isLoop ? 'physics' : 'cubic';
    }
    config[modelKey] = models;
  }
}

/** Re-exported from shared/types so the API and the config editor enforce one rule. */
export { validateControllerPwmActuators as validateControllerActuators } from '../../../shared/types.js';

/** Read + parse a config TOML. Defaults to the deployed config.toml (getConfigPath), but any
 *  path can be given — the config-profiles editor reads the active profile file this way.
 *  smol-toml is a strict TOML 1.0 parser, so actuator_roles' mixed-type inline arrays
 *  (e.g. ["NC", 1, 12]) parse natively — no special-casing needed. */
export function readConfig(path: string = getConfigPath()): any {
  try {
    const content = readFileSync(path, 'utf-8');
    const config = parseToml(content) as any;
    applyControllerDefaults(config);
    applyCalibrationModelDefaults(config);
    return config;
  } catch (error) {
    console.error('Failed to read config:', error);
    throw error;
  }
}

// ── Deployed-config cache ─────────────────────────────────────────────────────
// readConfig() had no cache, so every caller was a fresh readFileSync + TOML parse. Several are
// on hot paths: /api/gui-config, /api/pressure-limits and /api/sensor-config re-read per HTTP
// request, configStateName() re-read per operator command, and the Elodin VTable registry
// re-read on every connect plus 24 resubscribe retries.
//
// The cache is NOT "read once at boot". The backend is always-on — it is not one of the
// session-gated pipeline units — so it has to notice a deploy without restarting. But a deploy
// happens in exactly one function, deployActiveProfile(), which is also the only writer of
// config.toml on the normal path. So: cache freely, and invalidate there. Within a session no
// deploy can occur, which is precisely why the cached value is safe for the length of a run.
let deployedConfigCache: any = null;

/** The deployed config.toml, parsed once and reused until the next deploy. Callers must not
 *  mutate the returned object — it is shared. Use readConfig() for a private copy or for a
 *  path other than the deployed config. */
export function readDeployedConfig(): any {
  if (deployedConfigCache === null) deployedConfigCache = readConfig();
  return deployedConfigCache;
}

/** Drop the cached deployed config. Called from deployActiveProfile() — the single apply point —
 *  so any path that changes config.toml invalidates, without each call site having to remember. */
export function invalidateDeployedConfigCache(): void {
  deployedConfigCache = null;
}

/** Serialize + write a config object as TOML. Defaults to the deployed config.toml, but any path
 *  can be given — the config-profiles editor writes the active profile file this way. */
export function writeConfig(config: any, configPath: string = getConfigPath()): void {
  try {
    console.log(`💾 Writing config to: ${configPath}`);

    // Check if file is writable
    try {
      const stats = require('fs').statSync(configPath);
      console.log(`   File exists, size: ${stats.size} bytes`);
    } catch (statError) {
      console.warn(`   File may not exist yet, will create`);
    }

    // smol-toml (TOML 1.0) stringifies actuator_roles' mixed-type arrays natively and emits
    // integers without `_` digit separators, so no post-processing is needed.
    const content = stringifyToml(config ?? {});
    console.log(`   Generated TOML content: ${content.length} bytes`);

    // Write with explicit error handling
    writeFileSync(configPath, content, { encoding: 'utf-8', flag: 'w' });
    console.log(`✅ Config written successfully to ${configPath}`);
  } catch (error: any) {
    console.error('❌ Failed to write config:', error);
    console.error(`   Error code: ${error.code}`);
    console.error(`   Error message: ${error.message}`);
    if (error.code === 'EACCES') {
      throw new Error(`Permission denied: Cannot write to ${configPath}. Check file permissions.`);
    } else if (error.code === 'ENOENT') {
      throw new Error(`Path not found: ${configPath}. Check that the directory exists.`);
    }
    throw new Error(`Failed to write config: ${error.message}`);
  }
}

/**
 * Surgically set a single integer field on the `[boards.<key>]` section whose
 * `board_id` matches `boardId`, editing the raw TOML text in place. Unlike
 * writeConfig (whole-object round-trip via smol-toml, which drops comments and
 * could clobber a concurrent edit), this rewrites only the one line, leaving the
 * rest of the file — comments included — byte-for-byte unchanged. Used by the
 * Boards-tab logging-mode dropdown; config_broadcast_service re-reads the file.
 */
/**
 * Path to the active profile's config.toml.
 *
 * Deliberately computed here rather than imported from config-profiles.ts: that module already
 * imports this one, and a cycle between them is not worth introducing for one path. The pointer
 * format (config/.active_profile, one bare name) is the same one getConfigPath() reads below.
 */
function getActiveProfileConfigPath(): string {
  const dir = dirname(getConfigPath());
  let name = 'default';
  try {
    const a = readFileSync(join(dir, '.active_profile'), 'utf-8').trim();
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(a)) name = a;
  } catch { /* no pointer → default */ }
  return join(dir, 'profiles', name, 'config.toml');
}

/**
 * Surgically set one `[boards.<key>].<field>` in a TOML file, preserving comments and layout.
 *
 * Split out so the same edit can be applied to both the deployed config.toml and the active
 * profile — see patchBoardField().
 */
function patchBoardFieldInFile(
  path: string,
  boardId: number,
  field: string,
  value: number,
): void {
  const configPath = path;
  const raw = readFileSync(configPath, 'utf-8');

  // Map board_id → section key (e.g. "pt_board") via the parsed config.
  const boards = (readConfig()?.boards ?? {}) as Record<string, { board_id?: unknown }>;
  let boardKey: string | null = null;
  for (const [key, b] of Object.entries(boards)) {
    if (Number(b?.board_id) === boardId) { boardKey = key; break; }
  }
  if (!boardKey) throw new Error(`No board with board_id=${boardId} in config`);

  const esc = boardKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRe = new RegExp(`^\\s*\\[boards\\.${esc}\\]\\s*$`);
  const nextSectionRe = /^\s*\[/;
  const fieldRe = new RegExp(`^(\\s*)${field}(\\s*)=.*$`);

  const lines = raw.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) { start = i; break; }
  }
  if (start < 0) throw new Error(`Section [boards.${boardKey}] not found`);

  // Scan the block (header+1 .. next section header / EOF) for the field.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (nextSectionRe.test(lines[i])) { end = i; break; }
  }
  let replaced = false;
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(fieldRe);
    if (m) {
      lines[i] = `${m[1]}${field}${m[2]}= ${value}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) lines.splice(start + 1, 0, `${field} = ${value}`);

  writeFileSync(configPath, lines.join('\n'), { encoding: 'utf-8', flag: 'w' });
}

/**
 * Set one board field live, and record it in the active profile so it survives.
 *
 * This is the one config write that deliberately bypasses the draft-at-session-start rule:
 * board log/serial-print verbosity is turned up *because* something is misbehaving during a run,
 * and config_broadcast re-reads config.toml every cycle, so the byte reaches the board within a
 * second. That exception is intentional (see docs/CONFIGURATION_GUIDE.md).
 *
 * What was NOT intentional: it wrote only config.toml and never the profile, so the setting was
 * silently reverted by the next deployActiveProfile() — including the one at the very next
 * session start. Write both. The profile write is best-effort: failing to persist a debug setting
 * must not fail the live change the operator actually asked for.
 */
export function patchBoardField(boardId: number, field: string, value: number): void {
  patchBoardFieldInFile(getConfigPath(), boardId, field, value);
  invalidateDeployedConfigCache();
  try {
    patchBoardFieldInFile(getActiveProfileConfigPath(), boardId, field, value);
  } catch (e) {
    console.warn(
      `[config] board ${boardId} ${field}=${value} applied live but not persisted to the active ` +
      `profile — it will revert at the next deploy: ${(e as Error)?.message ?? e}`,
    );
  }
}
