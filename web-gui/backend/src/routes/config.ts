/**
 * Config file management routes
 * Handles reading and writing config.toml
 */

import { readFileSync, writeFileSync } from 'fs';
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

  throw new Error('Config file not found');
}

let _actuatorRolesParseWarned = false;

export function readConfig(): any {
  try {
    const path = getConfigPath();
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

export function writeConfig(config: any): void {
  const configPath = getConfigPath();
  try {
    console.log(`💾 Writing config to: ${configPath}`);

    // Check if file is writable
    try {
      const stats = require('fs').statSync(configPath);
      console.log(`   File exists, size: ${stats.size} bytes`);
    } catch (statError) {
      console.warn(`   File may not exist yet, will create`);
    }

    const content = stringifyToml(config);
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
