/**
 * Config file management routes
 * Handles reading and writing config.toml
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';
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
  // checkout that hasn't deployed a profile — self-heal by materializing it from the committed
  // default profile (config/profiles/default.toml) sitting next to it. This keeps the backend and
  // every C++ service that reads config.toml working without a manual bootstrap step.
  for (const path of possiblePaths) {
    const defaultProfile = join(dirname(path), 'profiles', 'default.toml');
    if (existsSync(defaultProfile)) {
      try {
        copyFileSync(defaultProfile, path);
        readFileSync(path, 'utf-8');
        console.log(`🌱 Generated config.toml from ${defaultProfile}`);
        return path;
      } catch { continue; }
    }
  }

  throw new Error('Config file not found (and no config/profiles/default.toml to generate it from)');
}

let _actuatorRolesParseWarned = false;

/** Read + parse a config TOML. Defaults to the deployed config.toml (getConfigPath), but any
 *  path can be given — the config-profiles editor reads the active profile file this way. */
export function readConfig(path: string = getConfigPath()): any {
  try {
    const content = readFileSync(path, 'utf-8');

    // Try to parse normally first
    try {
      const config = parseToml(content);
      applyControllerDefaults(config);
      return config;
    } catch (parseError: any) {
      // If parsing fails due to mixed types in arrays (actuator_roles), handle it manually
      if (parseError.message && parseError.message.includes('Inline lists must be a single type')) {
        if (!_actuatorRolesParseWarned) {
          _actuatorRolesParseWarned = true;
          console.warn('⚠️ TOML parser strict mode issue with actuator_roles, parsing manually (once).');
        }

        // Parse everything except actuator_roles
        const lines = content.split('\n');
        let inActuatorRoles = false;
        const configWithoutActuators: string[] = [];
        const actuatorRolesLines: string[] = [];

        for (const line of lines) {
          if (line.trim().startsWith('[actuator_roles]')) {
            inActuatorRoles = true;
          } else if (line.trim().startsWith('[') && inActuatorRoles) {
            inActuatorRoles = false;
            configWithoutActuators.push(line);
          } else if (inActuatorRoles) {
            actuatorRolesLines.push(line);
          } else {
            configWithoutActuators.push(line);
          }
        }

        const config = parseToml(configWithoutActuators.join('\n'));

        // Manually parse actuator_roles (trim lines so leading-space keys match)
        // Format: ["NC"|"NO", channel_id] or ["NC"|"NO", channel_id, board_id] or ["NC"|"NO", channel_id, "board_ip"]
        // Third element: number = board_id (preferred), string = legacy board_ip
        config.actuator_roles = {};
        for (const line of actuatorRolesLines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const matchStr = trimmed.match(/^"([^"]+)"\s*=\s*\["([^"]+)",\s*(\d+)(?:,\s*"([^"]+)")?\]/);
          const matchNum = trimmed.match(/^"([^"]+)"\s*=\s*\["([^"]+)",\s*(\d+),\s*(\d+)\]/);
          if (matchNum) {
            const [, name, type, channelId, boardId] = matchNum;
            const channel = parseInt(channelId, 10);
            const bid = parseInt(boardId, 10);
            (config.actuator_roles as any)[name] = [type, channel, bid];
          } else if (matchStr) {
            const [, name, type, channelId, boardIp] = matchStr;
            const channel = parseInt(channelId, 10);
            if (boardIp) {
              (config.actuator_roles as any)[name] = [type, channel, boardIp];
            } else {
              (config.actuator_roles as any)[name] = [type, channel];
            }
          }
        }

        applyControllerDefaults(config);
        return config;
      }
      throw parseError;
    }
  } catch (error) {
    console.error('Failed to read config:', error);
    throw error;
  }
}

/**
 * Serialize `actuator_roles` by hand. Its values are mixed-type inline arrays
 * (e.g. ["NC", 1, 12]) which @iarna/toml's stringify rejects ("Array values
 * can't have mixed types"), so we emit the section manually — the inverse of the
 * manual parse in readConfig. Strings are quoted, numbers are raw.
 */
function stringifyActuatorRoles(roles: Record<string, unknown>): string {
  const lines = ['[actuator_roles]'];
  for (const [name, value] of Object.entries(roles)) {
    const arr = Array.isArray(value) ? value : [];
    const parts = arr.map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v)));
    lines.push(`${JSON.stringify(name)} = [${parts.join(', ')}]`);
  }
  return lines.join('\n') + '\n';
}

/** Remove `_` digit-separators from numeric tokens in TOML text, leaving quoted
 *  strings intact. @iarna emits e.g. `port = 5_006`; our C++ parsers need `5006`.
 *  Char-level scan so it also covers numbers inside arrays (`[1_000, 2_000]`). */
export function stripNumericUnderscores(toml: string): string {
  let out = '';
  let quote: '"' | "'" | null = null; // inside a basic (") or literal (') string
  for (let i = 0; i < toml.length; i++) {
    const c = toml[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    // Drop a separator only when it sits between two digits, outside any string.
    if (c === '_' && /[0-9]/.test(toml[i - 1] ?? '') && /[0-9]/.test(toml[i + 1] ?? '')) continue;
    out += c;
  }
  return out;
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

    // actuator_roles holds mixed-type arrays that @iarna/toml can't stringify —
    // pull it out, stringify the rest, then append the section by hand.
    const { actuator_roles, ...rest } = config ?? {};
    let content = stringifyToml(rest);
    if (actuator_roles && typeof actuator_roles === 'object') {
      content += '\n' + stringifyActuatorRoles(actuator_roles as Record<string, unknown>);
    }
    // @iarna/toml stringifies integers ≥1000 with `_` digit separators (5006 → "5_006").
    // Valid TOML, but the minimal C++ config parsers use std::stoul, which stops at the
    // underscore (→ 5) — truncating ports/timeouts and crash-looping daq_bridge. Strip the
    // separators from numeric tokens; quoted strings are left untouched.
    content = stripNumericUnderscores(content);
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
 * writeConfig (whole-object round-trip via @iarna/toml, which drops comments and
 * could clobber a concurrent edit), this rewrites only the one line, leaving the
 * rest of the file — comments included — byte-for-byte unchanged. Used by the
 * Boards-tab logging-mode dropdown; config_broadcast_service re-reads the file.
 */
export function patchBoardField(boardId: number, field: string, value: number): void {
  const configPath = getConfigPath();
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
