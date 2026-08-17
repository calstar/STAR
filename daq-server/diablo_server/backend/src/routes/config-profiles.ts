/**
 * Named config profiles v2 — profiles are the editable source of truth; config.toml is the
 * *deployed* file the pipeline reads.
 *
 *   - The Config editor reads/writes the ACTIVE PROFILE (config/profiles/<name>.toml).
 *   - "Deploying" copies the active profile into config.toml.
 *   - Deploy happens on an idle save/switch and at (live) session start.
 *   - During a session config.toml is FROZEN: the editor writes profile drafts only, applied at
 *     the next session start. This is what makes editing during a run safe — a mid-run edit can no
 *     longer reach the running config.
 *
 * config.toml stays git-tracked in this phase (a later phase makes it a pure generated artifact).
 * The active-profile pointer (config/.active_profile) is machine-specific runtime state.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'fs';
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

export function profilePath(name: string): string {
  assertValidName(name);
  return join(getProfilesDir(), `${name}.toml`);
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
  const hasAny = readdirSync(dir).some((f) => f.endsWith('.toml'));
  if (!hasAny && existsSync(getConfigPath())) {
    copyFileSync(getConfigPath(), join(dir, `${DEFAULT_PROFILE}.toml`));
    setActiveProfileName(DEFAULT_PROFILE);
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
  return readdirSync(getProfilesDir())
    .filter((f) => f.endsWith('.toml'))
    .map((f) => f.slice(0, -'.toml'.length))
    .filter((n) => NAME_RE.test(n))
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
  const src = getActiveProfilePath();
  if (!readFileSync(src, 'utf-8').trim()) throw new Error(`Active profile "${getActiveProfileName()}" is empty`);
  const configPath = getConfigPath();
  const previous = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;
  copyFileSync(src, configPath);
  try {
    readConfig(); // parse the freshly-deployed config.toml
  } catch (e) {
    if (previous !== null) writeFileSync(configPath, previous, 'utf-8');
    throw new Error(`Active profile is not valid config: ${(e as Error)?.message ?? e}`);
  }
}

/** Make <name> active and deploy it to config.toml. Caller gates on "no session running". */
export function switchProfile(name: string): void {
  ensureSeeded();
  if (!existsSync(profilePath(name))) throw new Error(`Profile "${name}" does not exist`);
  setActiveProfileName(name);
  deployActiveProfile();
}

// ── Create / rename / delete ─────────────────────────────────────────────────

/** Create a new profile from the active profile (or another named profile). Does NOT switch. */
export function createProfile(name: string, fromName?: string): void {
  ensureSeeded();
  assertValidName(name);
  const dest = profilePath(name);
  if (existsSync(dest)) throw new Error(`Profile "${name}" already exists`);
  const src = fromName ? profilePath(fromName) : getActiveProfilePath();
  if (!existsSync(src)) throw new Error(`Source ${fromName ? `profile "${fromName}"` : 'active profile'} not found`);
  copyFileSync(src, dest);
}

/** Rename a profile file; if it was active, move the pointer with it. Does not redeploy. */
export function renameProfile(name: string, newName: string): void {
  ensureSeeded();
  const src = profilePath(name);
  const dest = profilePath(newName);
  if (!existsSync(src)) throw new Error(`Profile "${name}" does not exist`);
  if (existsSync(dest)) throw new Error(`Profile "${newName}" already exists`);
  renameSync(src, dest);
  if (getActiveProfileName() === name) setActiveProfileName(newName);
}

/** Delete a profile. Refuses to delete the active one. */
export function deleteProfile(name: string): void {
  ensureSeeded();
  if (getActiveProfileName() === name) throw new Error(`Cannot delete the active profile "${name}"`);
  const p = profilePath(name);
  if (!existsSync(p)) throw new Error(`Profile "${name}" does not exist`);
  unlinkSync(p);
}
