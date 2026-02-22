/**
 * Config file management routes
 * Handles reading and writing config.toml
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';

const CONFIG_PATH = process.env.CONFIG_PATH ||
  join(process.cwd(), '..', 'config', 'config.toml');

export function getConfigPath(): string {
  // Try multiple possible paths
  const possiblePaths = [
    CONFIG_PATH,
    join(process.cwd(), '..', '..', 'config', 'config.toml'),
    '/home/kush-mahajan/sensor_system/config/config.toml',
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

export function readConfig(): any {
  try {
    const path = getConfigPath();
    const content = readFileSync(path, 'utf-8');

    // Try to parse normally first
    try {
      return parseToml(content);
    } catch (parseError: any) {
      // If parsing fails due to mixed types in arrays (actuator_roles), handle it manually
      if (parseError.message && parseError.message.includes('Inline lists must be a single type')) {
        console.warn('⚠️ TOML parser strict mode issue with actuator_roles, parsing manually...');

        // Parse everything except actuator_roles
        const lines = content.split('\n');
        let inActuatorRoles = false;
        const configWithoutActuators: string[] = [];
        const actuatorRolesLines: string[] = [];

        for (const line of lines) {
          if (line.trim().startsWith('[actuator_roles]')) {
            inActuatorRoles = true;
            // Don't include this line in the config we'll parse
          } else if (line.trim().startsWith('[') && inActuatorRoles) {
            inActuatorRoles = false;
            configWithoutActuators.push(line);
          } else if (inActuatorRoles) {
            actuatorRolesLines.push(line);
          } else {
            configWithoutActuators.push(line);
          }
        }

        // Parse config without actuator_roles
        const config = parseToml(configWithoutActuators.join('\n'));

        // Manually parse actuator_roles
        // Format: ["NC"|"NO", channel_id] or ["NC"|"NO", channel_id, "board_ip"]
        config.actuator_roles = {};
        for (const line of actuatorRolesLines) {
          // Match with optional board IP: ["NC", 1] or ["NC", 1, "192.168.2.201"]
          const match2 = line.match(/^"([^"]+)"\s*=\s*\["([^"]+)",\s*(\d+)(?:,\s*"([^"]+)")?\]/);
          if (match2) {
            const [, name, type, channelId, boardIp] = match2;
            const channel = parseInt(channelId, 10);
            // If board IP is provided, include it; otherwise default to first board
            if (boardIp) {
              (config.actuator_roles as any)[name] = [type, channel, boardIp];
            } else {
              (config.actuator_roles as any)[name] = [type, channel];
            }
          }
        }

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
  try {
    const path = getConfigPath();
    console.log(`💾 Writing config to: ${path}`);

    // Check if file is writable
    try {
      const stats = require('fs').statSync(path);
      console.log(`   File exists, size: ${stats.size} bytes`);
    } catch (statError) {
      console.warn(`   File may not exist yet, will create`);
    }

    const content = stringifyToml(config);
    console.log(`   Generated TOML content: ${content.length} bytes`);

    // Write with explicit error handling
    writeFileSync(path, content, { encoding: 'utf-8', flag: 'w' });
    console.log(`✅ Config written successfully to ${path}`);
  } catch (error: any) {
    console.error('❌ Failed to write config:', error);
    console.error(`   Error code: ${error.code}`);
    console.error(`   Error message: ${error.message}`);
    if (error.code === 'EACCES') {
      throw new Error(`Permission denied: Cannot write to ${path}. Check file permissions.`);
    } else if (error.code === 'ENOENT') {
      throw new Error(`Path not found: ${path}. Check that the directory exists.`);
    }
    throw new Error(`Failed to write config: ${error.message}`);
  }
}
