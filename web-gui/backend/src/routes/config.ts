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
    return parseToml(content);
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
