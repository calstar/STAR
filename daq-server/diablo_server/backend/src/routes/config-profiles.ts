/**
 * Named config profiles v3 — a profile is a DIRECTORY, and it owns its state-machine CSVs.
 *
 *   config/profiles/<name>/config.toml                  <- tracked source of truth
 *   config/profiles/<name>/state_machine_actuators.csv
 *   config/profiles/<name>/state_transitions.csv
 *
 * Deploying copies the whole directory out to config/, so switching profiles switches the CSVs
 * too. The C++ services keep reading config/state_machine_actuators.csv with their existing
 * hardcoded fallback paths — they never learn that profiles exist.
 *
 *   - The Config editor reads/writes the ACTIVE PROFILE (config/profiles/<name>/config.toml).
 *   - "Deploying" copies the active profile's config.toml + every .csv into config/.
 *   - Deploy happens on an idle save/switch and at (live) session start.
 *   - During a session config.toml is FROZEN: the editor writes profile drafts only, applied at
 *     the next session start. This is what makes editing during a run safe — a mid-run edit can no
 *     longer reach the running config.
 *
 * config.toml stays git-tracked in this phase (a later phase makes it a pure generated artifact).
 * The active-profile pointer (config/.active_profile) is machine-specific runtime state.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { getConfigPath, readConfig, writeConfig } from './config.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_PROFILE = 'default';

function assertValidName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid profile name "${name}" (use letters, digits, _ or -, max 64 chars)`);
  }
}

function getConfigDir(): string {
  return dirname(getConfigPath());
}

export function getProfilesDir(): string {
  return join(getConfigDir(), 'profiles');
}

function getActivePointerPath(): string {
  return join(getConfigDir(), '.active_profile');
}

/** Directory holding one profile: its config.toml and its CSVs. */
export function profileDir(name: string): string {
  assertValidName(name);
  return join(getProfilesDir(), name);
}

/** The config file inside a profile directory (the editor's target). */
export function profilePath(name: string): string {
  return join(profileDir(name), 'config.toml');
}

/** Profile-owned files that deploy alongside config.toml. */
function profileAssets(name: string): string[] {
  try {
    return readdirSync(profileDir(name)).filter((f) => f.endsWith('.csv')).sort();
  } catch {
    return [];
  }
}

export function getActiveProfileName(): string {
  try {
    const raw = readFileSync(getActivePointerPath(), 'utf-8').trim();
    if (raw && NAME_RE.test(raw)) return raw;
  } catch { /* missing pointer → default */ }
  return DEFAULT_PROFILE;
}

export function setActiveProfileName(name: string): void {
  assertValidName(name);
  writeFileSync(getActivePointerPath(), `${name}\n`, 'utf-8');
}

/**
 * First-run seeding (idempotent): if no profiles exist, snapshot the current config.toml as
 * profiles/default.toml and point .active_profile at it. Keeps config.toml as the deployed file.
 */
export function ensureSeeded(): void {
  const dir = getProfilesDir();
  mkdirSync(dir, { recursive: true });

  // v2 → v3: a profile used to be a flat <name>.toml. Fold each one into <name>/config.toml so it
  // can own its CSVs. Idempotent; runs once per box.
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.toml')) continue;
    const name = f.slice(0, -'.toml'.length);
    if (!NAME_RE.test(name)) continue;
    const flat = join(dir, f);
    if (!statSync(flat).isFile()) continue;
    mkdirSync(join(dir, name), { recursive: true });
    renameSync(flat, join(dir, name, 'config.toml'));
    console.log(`🌱 Migrated profile "${name}" to a directory`);
  }

  const names = listProfileNames();
  if (names.length === 0 && existsSync(getConfigPath())) {
    mkdirSync(profileDir(DEFAULT_PROFILE), { recursive: true });
    copyFileSync(getConfigPath(), profilePath(DEFAULT_PROFILE));
    setActiveProfileName(DEFAULT_PROFILE);
  }

  // Adopt any CSVs still sitting loose in config/ into profiles that have none. Covers both the
  // v2→v3 upgrade and a fresh seed, and is a no-op once each profile owns its own copies.
  const configDir = getConfigDir();
  const loose = readdirSync(configDir).filter((f) => f.endsWith('.csv'));
  if (loose.length) {
    for (const name of listProfileNames()) {
      if (profileAssets(name).length) continue;
      for (const f of loose) copyFileSync(join(configDir, f), join(profileDir(name), f));
      console.log(`🌱 Adopted ${loose.length} CSV(s) into profile "${name}"`);
    }
  }

  // The deployed CSVs are generated artifacts (gitignored, like config.toml). The C++ services read
  // them from config/ by hardcoded path and have no idea profiles exist, so a fresh checkout must
  // materialize them before any pipeline start — deployActiveProfile() only runs on save/switch and
  // at LIVE session start, and a simulated run never deploys at all.
  const activeName = getActiveProfileName();
  for (const f of profileAssets(activeName)) {
    const target = join(configDir, f);
    if (existsSync(target)) continue;
    try {
      copyFileSync(join(profileDir(activeName), f), target);
      console.log(`🌱 Materialized ${f} from profile "${activeName}"`);
    } catch { /* best-effort */ }
  }
}

/** Profile directory names, unsorted. Does NOT call ensureSeeded (used from inside it). */
function listProfileNames(): string[] {
  try {
    return readdirSync(getProfilesDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && NAME_RE.test(e.name))
      .filter((e) => existsSync(join(getProfilesDir(), e.name, 'config.toml')))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Path of the active profile file (the editor target). */
export function getActiveProfilePath(): string {
  ensureSeeded();
  return profilePath(getActiveProfileName());
}

export interface ProfileInfo { name: string; active: boolean }

export function listProfiles(): ProfileInfo[] {
  ensureSeeded();
  const active = getActiveProfileName();
  return listProfileNames()
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, active: name === active }));
}

// ── Editor read/write: operate on the ACTIVE PROFILE ─────────────────────────

/** Parse the active profile (what the Config editor displays). */
export function readActiveProfile(): any {
  return readConfig(getActiveProfilePath());
}

/** Serialize + write a config object into the active profile file (an editor save / a draft). */
export function writeActiveProfile(config: any): void {
  writeConfig(config, getActiveProfilePath());
}

// ── Deploy: copy the active profile → config.toml (what the pipeline reads) ───

/**
 * Copy the active profile into config.toml, validating it parses first and rolling config.toml
 * back to its previous contents if not. Caller must only invoke this when it's safe to change the
 * running config (no session active, or at a controlled session start).
 */
export function deployActiveProfile(): void {
  const name = getActiveProfileName();
  const src = getActiveProfilePath();
  if (!readFileSync(src, 'utf-8').trim()) throw new Error(`Active profile "${name}" is empty`);
  const configPath = getConfigPath();
  const configDir = getConfigDir();

  // All-or-nothing: the CSVs and config.toml describe one machine together, so a half-applied
  // deploy (new roles, old state table) is worse than no deploy. Snapshot every target first and
  // put them all back if the config does not parse.
  const targets: { path: string; previous: string | null }[] = [];
  const snapshot = (path: string) =>
    targets.push({ path, previous: existsSync(path) ? readFileSync(path, 'utf-8') : null });

  snapshot(configPath);
  const assets = profileAssets(name);
  for (const f of assets) snapshot(join(configDir, f));

  try {
    copyFileSync(src, configPath);
    for (const f of assets) copyFileSync(join(profileDir(name), f), join(configDir, f));
    readConfig(); // parse the freshly-deployed config.toml
  } catch (e) {
    for (const t of targets) {
      try {
        if (t.previous !== null) writeFileSync(t.path, t.previous, 'utf-8');
        else rmSync(t.path, { force: true });
      } catch { /* best-effort rollback */ }
    }
    throw new Error(`Active profile is not valid config: ${(e as Error)?.message ?? e}`);
  }
}

/** Make <name> active and deploy it to config.toml. Caller gates on "no session running". */
export function switchProfile(name: string): void {
  ensureSeeded();
  if (!existsSync(profilePath(name))) throw new Error(`Profile "${name}" does not exist`);
  // The pointer moves first because deployActiveProfile() reads it — but if the deploy fails the
  // pointer has to come back, or the editor shows the new profile while the pipeline still runs
  // the old one's config and CSVs, with nothing on screen saying so.
  const previous = getActiveProfileName();
  setActiveProfileName(name);
  try {
    deployActiveProfile();
  } catch (e) {
    setActiveProfileName(previous);
    throw e;
  }
}

// ── State-machine CSVs: read/write inside the ACTIVE PROFILE ─────────────────

/** The CSVs the State Management tab edits, keyed by the short name the API takes. */
export const STATE_CSVS = {
  actuators: 'state_machine_actuators.csv',
  delays: 'state_machine_actuator_delays.csv',
  transitions: 'state_transitions.csv',
} as const;
export type StateCsvName = keyof typeof STATE_CSVS;

export function isStateCsvName(v: string): v is StateCsvName {
  return Object.prototype.hasOwnProperty.call(STATE_CSVS, v);
}

/** Read one state CSV from the active profile. Falls back to the deployed copy on a box whose
 *  profile predates the CSVs (ensureSeeded normally adopts them, but never assume). */
export function readStateCsv(which: StateCsvName): string {
  ensureSeeded();
  const file = STATE_CSVS[which];
  const inProfile = join(profileDir(getActiveProfileName()), file);
  if (existsSync(inProfile)) return readFileSync(inProfile, 'utf-8');
  const deployed = join(getConfigDir(), file);
  if (existsSync(deployed)) return readFileSync(deployed, 'utf-8');
  return '';
}

/**
 * Write one state CSV into the active profile, and deploy it when idle.
 *
 * Mirrors the config save rule: during a session the profile takes the edit as a draft and
 * config/ is left frozen, so a mid-run edit cannot reach the running pipeline.
 * Returns whether the write reached config/.
 */
export function writeStateCsv(which: StateCsvName, content: string, deploy: boolean): boolean {
  ensureSeeded();
  const file = STATE_CSVS[which];
  const name = getActiveProfileName();
  mkdirSync(profileDir(name), { recursive: true });
  writeFileSync(join(profileDir(name), file), content, 'utf-8');
  if (!deploy) return false;
  copyFileSync(join(profileDir(name), file), join(getConfigDir(), file));
  return true;
}

// ── Create / rename / delete ─────────────────────────────────────────────────

/** Create a new profile from the active profile (or another named profile). Does NOT switch. */
export function createProfile(name: string, fromName?: string): void {
  ensureSeeded();
  assertValidName(name);
  const destDir = profileDir(name);
  if (existsSync(destDir)) throw new Error(`Profile "${name}" already exists`);
  const srcName = fromName ?? getActiveProfileName();
  const srcCfg = profilePath(srcName);
  if (!existsSync(srcCfg)) throw new Error(`Source ${fromName ? `profile "${fromName}"` : 'active profile'} not found`);
  // Copy the whole profile — a new profile inherits the source's CSVs, not the previous
  // deployment's, or it would start with a state table that does not match its own roles.
  mkdirSync(destDir, { recursive: true });
  copyFileSync(srcCfg, profilePath(name));
  for (const f of profileAssets(srcName)) copyFileSync(join(profileDir(srcName), f), join(destDir, f));
}

/** Rename a profile file; if it was active, move the pointer with it. Does not redeploy. */
export function renameProfile(name: string, newName: string): void {
  ensureSeeded();
  assertValidName(newName);
  const src = profileDir(name);
  const dest = profileDir(newName);
  if (!existsSync(profilePath(name))) throw new Error(`Profile "${name}" does not exist`);
  if (existsSync(dest)) throw new Error(`Profile "${newName}" already exists`);
  renameSync(src, dest);
  if (getActiveProfileName() === name) setActiveProfileName(newName);
}

/** Delete a profile. Refuses to delete the active one. */
export function deleteProfile(name: string): void {
  ensureSeeded();
  if (getActiveProfileName() === name) throw new Error(`Cannot delete the active profile "${name}"`);
  if (!existsSync(profilePath(name))) throw new Error(`Profile "${name}" does not exist`);
  rmSync(profileDir(name), { recursive: true, force: true });
}
