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
        config.actuator_roles = {};
        for (const line of actuatorRolesLines) {
          const match = line.match(/^"([^"]+)"\s*=\s*\["([^"]+)",\s*(\d+)\]/);
          if (match) {
            const [, name, type, channelId] = match;
            // Type assertion to allow mixed array types
            (config.actuator_roles as any)[name] = [type, parseInt(channelId, 10)];
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
    const content = stringifyToml(config);
    writeFileSync(path, content, 'utf-8');
  } catch (error) {
    console.error('Failed to write config:', error);
    throw error;
  }
}
