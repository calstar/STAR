/**
 * Operator commands for the Bluetooth switches (Switches page -> switch_service).
 *
 * The WS handler gates these like every engine-control command (approved operator, control
 * unlocked; server.ts CONTROL_COMMAND_TYPES). This module only checks the request against the
 * deployed config and turns it into the one-line form switch_service reads on loopback UDP:
 * "<command_id> <role> <output>". switch_service checks it again and sends one SWITCH_COMMAND; the
 * env board's answer comes back as SW<role>.cmd_id / cmd_result through Elodin, and the switch's
 * own status says what it did. Nothing is retried or queued here.
 */
import * as dgram from 'dgram';

export interface SwitchCommandRequest {
  switchRole?: number;
  switchOutput?: number;
  switchCommandId?: number;
}

export type SwitchCommandPlan = { line: string; port: number } | { error: string };

export function planSwitchCommand(data: SwitchCommandRequest, config: unknown): SwitchCommandPlan {
  const cfg = config as { switch_service?: { enabled?: unknown; command_port?: unknown };
    switch_roles?: Record<string, { role?: unknown }> } | null;
  if (!cfg || cfg.switch_service?.enabled !== true) return { error: 'Switches are not enabled ([switch_service] in config.toml).' };
  const role = data.switchRole;
  const output = data.switchOutput;
  const id = data.switchCommandId;
  if (!Number.isInteger(role)) return { error: 'Switch command without a role.' };
  // Absolute only: 1 = arm, 0 = disarm. There is no toggle.
  if (output !== 0 && output !== 1) return { error: 'Switch command output must be arm (1) or disarm (0).' };
  if (!Number.isInteger(id) || id! < 0 || id! > 0xffff) return { error: 'Switch command id must be 0-65535.' };
  const listed = Object.values(cfg.switch_roles ?? {}).some((r) => Number(r?.role) === role);
  if (!listed) return { error: `No switch is configured as role ${role}.` };
  const portRaw = Number(cfg.switch_service.command_port ?? 8094);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 8094;
  return { line: `${id} ${role} ${output}\n`, port };
}

let sock: dgram.Socket | null = null;

export function sendSwitchCommand(line: string, port: number): void {
  if (!sock) {
    sock = dgram.createSocket('udp4');
    sock.on('error', (e) => console.error('[Switches] command socket:', e.message));
    sock.unref();
  }
  sock.send(line, port, '127.0.0.1');
}

/** "Find switches": a 10 s scan on the env board for switches not on the list. Moves nothing. */
export function planSwitchDiscover(config: unknown): SwitchCommandPlan {
  const cfg = config as { switch_service?: { enabled?: unknown; command_port?: unknown } } | null;
  if (!cfg || cfg.switch_service?.enabled !== true) return { error: 'Switches are not enabled ([switch_service] in config.toml).' };
  const portRaw = Number(cfg.switch_service.command_port ?? 8094);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 8094;
  return { line: 'discover\n', port };
}
