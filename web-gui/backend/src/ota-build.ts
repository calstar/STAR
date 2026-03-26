/**
 * Build DiabloAvionics firmware with PlatformIO.
 * Scans external/DiabloAvionics for platformio.ini projects,
 * runs `pio run`, and returns the firmware.bin path.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, execSync } from 'child_process';
import { readConfig } from './routes/config.js';

const DIABLOAVIONICS_REL = 'external/DiabloAvionics';

function getWorkspaceRoot(): string {
  const cwd = process.cwd();
  // Try cwd, then cwd/.., then cwd/../.. for external/DiabloAvionics
  for (const root of [cwd, path.join(cwd, '..'), path.join(cwd, '..', '..')]) {
    const p = path.join(root, DIABLOAVIONICS_REL);
    if (fs.existsSync(p)) return path.resolve(root);
  }
  return path.resolve(cwd, '..', '..'); // fallback: web-gui/backend -> sensor_system
}

/** Repo root containing external/DiabloAvionics (OTA paths, config). */
export function getOtaWorkspaceRoot(): string {
  return getWorkspaceRoot();
}

export interface OtaProject {
  path: string;       // relative to workspace, e.g. external/DiabloAvionics/Hotfire_Code/PT_Hotfire
  name: string;       // display name, e.g. PT_Hotfire
}

export interface BuildResult {
  success: boolean;
  firmwarePath?: string;
  firmwareBuffer?: Buffer;
  buildOutput?: string;
  error?: string;
}

/**
 * Scan for PlatformIO projects under external/DiabloAvionics.
 */
export function discoverProjects(): OtaProject[] {
  const root = getWorkspaceRoot();
  const diabloPath = path.join(root, DIABLOAVIONICS_REL);
  if (!fs.existsSync(diabloPath)) return [];

  const projects: OtaProject[] = [];
  const walk = (dir: string, relPrefix: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.join(relPrefix, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === '.pio' || e.name === 'node_modules') continue;
        walk(full, rel);
      } else if (e.name === 'platformio.ini') {
        const name = path.basename(path.dirname(rel));
        projects.push({ path: rel.replace(/\\/g, '/'), name });
      }
    }
  };
  walk(diabloPath, DIABLOAVIONICS_REL);
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

function getFirstEnv(platformioIniPath: string): string | null {
  const content = fs.readFileSync(platformioIniPath, 'utf8');
  const m = content.match(/\[env:([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

function findPioCommand(): string {
  try {
    execSync('pio --version', { stdio: 'ignore' });
    return 'pio';
  } catch {
    try {
      execSync('platformio --version', { stdio: 'ignore' });
      return 'platformio';
    } catch {
      return 'pio';
    }
  }
}

/**
 * Build a PlatformIO project and return the firmware binary.
 * @param projectPath - Path to project (relative to workspace or absolute)
 * @param buildFlags - Optional extra build flags, e.g. '-DTEMP_HARDCODE_BOARD_ID=21'
 */
export async function buildProject(projectPath: string, buildFlags?: string): Promise<BuildResult> {
  const root = getWorkspaceRoot();
  const absPath = path.isAbsolute(projectPath)
    ? projectPath
    : path.join(root, projectPath);

  const platformioIni = path.join(absPath, 'platformio.ini');
  if (!fs.existsSync(platformioIni)) {
    return { success: false, error: `No platformio.ini at ${projectPath}` };
  }

  const env = getFirstEnv(platformioIni) || 'adafruit_feather_esp32s3';
  const buildDir = path.join(absPath, '.pio', 'build', env);
  const firmwareBin = path.join(buildDir, 'firmware.bin');

  const pioCmd = findPioCommand();
  const procEnv = { ...process.env };
  if (buildFlags) {
    procEnv.PLATFORMIO_BUILD_FLAGS = (procEnv.PLATFORMIO_BUILD_FLAGS || '') + ' ' + buildFlags;
  }

  return new Promise((resolve) => {
    const proc = spawn(pioCmd, ['run'], {
      cwd: absPath,
      env: procEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const output = stdout + stderr;
      if (code !== 0) {
        resolve({
          success: false,
          buildOutput: output,
          error: `Build failed (exit ${code})`,
        });
        return;
      }

      if (!fs.existsSync(firmwareBin)) {
        resolve({
          success: false,
          buildOutput: output,
          error: `firmware.bin not found at ${firmwareBin}`,
        });
        return;
      }

      try {
        const firmwareBuffer = fs.readFileSync(firmwareBin);
        resolve({
          success: true,
          firmwarePath: firmwareBin,
          firmwareBuffer,
          buildOutput: output,
        });
      } catch (err: any) {
        resolve({
          success: false,
          buildOutput: output,
          error: err.message || 'Failed to read firmware.bin',
        });
      }
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        error: `Failed to run ${pioCmd}: ${err.message}. Install PlatformIO CLI: pip install platformio`,
      });
    });
  });
}

/** Board type → DiabloAvionics project path (firmware with TEMP_HARDCODE_BOARD_ID support) */
export const BOARD_TYPE_TO_PROJECT: Record<string, string> = {
  PT: 'external/DiabloAvionics/Hotfire_Code/PT_Hotfire',
  ACTUATOR: 'external/DiabloAvionics/Hotfire_Code/Actuator_Hotfire',
  LC: 'external/DiabloAvionics/Hotfire_Code/LC_Hotfire',
  TC: 'external/DiabloAvionics/Hotfire_Code/TC_Hotfire',
  RTD: 'external/DiabloAvionics/Hotfire_Code/RTD_Hotfire',
};

export interface FlashAllBoard {
  key: string;
  type: string;
  ip: string;
  boardId: number;
}

/** Enabled boards from config.toml (for flash-all UIs). */
export function getEnabledBoardsForFlash(): FlashAllBoard[] {
  const config = readConfig();
  const boards = (config.boards || {}) as Record<string, Record<string, unknown>>;
  const out: FlashAllBoard[] = [];
  for (const [key, raw] of Object.entries(boards)) {
    if (raw.enabled === false) continue;
    const type = typeof raw.type === 'string' ? raw.type : 'UNKNOWN';
    const ip = typeof raw.ip === 'string' ? raw.ip : '';
    const boardId =
      typeof raw.board_id === 'number'
        ? raw.board_id
        : typeof raw.board_number === 'number'
          ? raw.board_number
          : 1;
    if (!ip || !type) continue;
    out.push({ key, type, ip, boardId });
  }
  return out;
}

export interface FlashAllResult {
  success: boolean;
  total: number;
  flashed: number;
  failed: number;
  results: Array<{
    key: string;
    type: string;
    ip: string;
    boardId: number;
    success: boolean;
    error?: string;
  }>;
}
