'use client'

import { useState, useEffect } from 'react';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType } from '@/lib/types';

interface ConfigData {
  server_heartbeat?: {
    interval_ms?: number;
    broadcast_port?: number;
    broadcast_ip?: string;
  };
  system?: {
    mode?: string;
    state?: string;
  };
  network?: {
    bind_ip?: string;
    sensor_port?: number;
    actuator_cmd_port?: number;
    buffer_size?: number;
  };
  database?: {
    host?: string;
    port?: number;
    auto_flush_interval_ms?: number;
    max_buffer_size?: number;
    connection_retry_attempts?: number;
    connection_retry_delay_ms?: number;
  };
  discovery?: {
    enabled?: boolean;
    network_interface?: string;
    mode?: string;
    subnet?: string;
    ip_range_start?: number;
    ip_range_end?: number;
    discovery_timeout_seconds?: number;
  };
  boards?: Record<string, any>;
  sensor_roles?: Record<string, number>; // legacy fallback
  sensor_roles_pt_board?: Record<string, number>;
  sensor_roles_pt2?: Record<string, number>;
  abort_pts?: Record<string, number>;
  actuator_roles?: Record<string, [string, number] | [string, number, number] | [string, number, string]>;
  actuator_abbrev?: Record<string, string>;
  routing?: Record<string, any>;
  calibration?: any;
  pressure_limits?: Record<string, any>;
  pressure_mappings?: Record<string, number>;
  display?: Record<string, any>;
  state_machine?: Record<string, string>;
  controller?: {
    pwm_frequency_hz?: number;
    pwm_duration_ms?: number;
    fallback_fuel_duty_cycle?: number;
    fallback_ox_duty_cycle?: number;
    controller_loop_hz?: number;
    controller_service_url?: string;
    controller_config_path?: string;
    command_type?: 'THRUST_DESIRED' | 'ALTITUDE_GOAL' | 'PRESSURE_TARGET' | string;
    thrust_desired?: number;
    altitude_goal?: number;
    pressure_fuel_target?: number;
    pressure_ox_target?: number;
    duty_sweep_enabled?: boolean;
    duty_sweep_step_duration_sec?: number;
    duty_sweep_steps?: [number, number][];
    use_cpp_controller?: boolean;
  };
  phase2?: Record<string, any>;
}

// Keep defaults minimal: config.toml is the source of truth.
const DEFAULT_CONFIG: ConfigData = {};

export default function ConfigPage() {
  const [config, setConfig] = useState<ConfigData>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [activeTab, setActiveTab] = useState('system');
  const [advancedText, setAdvancedText] = useState('');
  const [advancedError, setAdvancedError] = useState<string | null>(null);

  const ws = getWebSocketClient();

  useEffect(() => {
    ws.connect();
    loadConfig();

    const unsubscribe = ws.on(MessageType.CONNECTION_STATUS, () => {
      // Connection status updates
    });

    return unsubscribe;
  }, [ws]);

  const loadConfig = async () => {
    try {
      setLoading(true);
      setError(null);

      // Request config from backend
      const response = await fetch('/api/config');
      if (!response.ok) {
        throw new Error('Failed to load config');
      }

      const data = await response.json();
      // config.toml is canonical; don't overlay stale defaults
      const nextConfig = (data.config || {}) as ConfigData;
      setConfig(nextConfig);
      setAdvancedText(JSON.stringify(nextConfig, null, 2));
      setAdvancedError(null);
      setLoading(false);
    } catch (err: any) {
      setError(err?.message || 'Failed to load config');
      setLoading(false);
    }
  };

  const saveConfig = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(false);

      const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to save config');
      }

      setSuccess(true);
      setSaving(false);
      // Re-fetch canonical config so UI mirrors what was written to disk
      await loadConfig();
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to save config');
      setSaving(false);
    }
  };

  const updateField = (section: string, field: string, value: any, subSection?: string) => {
    setConfig((prev) => {
      const next: any = { ...(prev as any) };
      if (subSection) {
        next[section] = { ...(next[section] || {}) };
        next[section][subSection] = { ...(next[section]?.[subSection] || {}) };
        if (value === undefined) {
          delete next[section][subSection][field];
        } else {
          next[section][subSection][field] = value;
        }
      } else {
        next[section] = { ...(next[section] || {}) };
        if (value === undefined) {
          delete next[section][field];
        } else {
          next[section][field] = value;
        }
      }
      return next as ConfigData;
    });
  };

  const updateBoard = (boardKey: string, field: string, value: any) => {
    setConfig((prev) => {
      const next: ConfigData = { ...prev };
      const boards: Record<string, any> = { ...(next.boards || {}) };
      const board: Record<string, any> = { ...(boards[boardKey] || {}) };
      if (value === undefined) {
        delete board[field];
      } else {
        board[field] = value;
      }
      boards[boardKey] = board;
      next.boards = boards;
      return next;
    });
  };

  const updateArrayField = (section: string, field: string, value: string) => {
    const array = value.split(',').map(s => s.trim()).filter(s => s).map(s => {
      const num = parseInt(s, 10);
      return isNaN(num) ? s : num;
    });
    updateField(section, field, array);
  };

  const renderField = (
    label: string,
    value: any,
    onChange: (val: any) => void,
    type: 'text' | 'number' | 'select' | 'boolean' | 'array' = 'text',
    options?: string[],
    description?: string
  ) => {
    return (
      <div className="space-y-1">
        <label className="block text-sm font-semibold">
          {label}
          {description && <span className="text-xs text-text-muted ml-2">({description})</span>}
        </label>
        {type === 'select' ? (
          <select
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white"
          >
            {options?.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        ) : type === 'boolean' ? (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!value}
              onChange={(e) => onChange(e.target.checked)}
              className="w-4 h-4"
            />
            <span>{value ? 'Enabled' : 'Disabled'}</span>
          </label>
        ) : type === 'array' ? (
          <input
            type="text"
            value={Array.isArray(value) ? value.join(', ') : ''}
            onChange={(e) => {
              const array = e.target.value.split(',').map(s => s.trim()).filter(s => s).map(s => {
                const num = parseInt(s, 10);
                return isNaN(num) ? s : num;
              });
              onChange(array);
            }}
            className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white"
            placeholder="Comma-separated values (e.g., 1, 2, 3)"
          />
        ) : type === 'number' ? (
          <input
            type="number"
            value={value ?? ''}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') {
                onChange(undefined);
                return;
              }
              const n = Number(raw);
              onChange(Number.isFinite(n) ? n : undefined);
            }}
            className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white"
          />
        ) : (
          <input
            type="text"
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white"
          />
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-background text-text p-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center">Loading configuration...</div>
        </div>
      </main>
    );
  }

  const tabs = [
    { id: 'system', label: 'System' },
    { id: 'network', label: 'Network' },
    { id: 'server_heartbeat', label: 'Heartbeat' },
    { id: 'database', label: 'Database' },
    { id: 'discovery', label: 'Discovery' },
    { id: 'boards', label: 'Boards' },
    { id: 'sensor_roles', label: 'Sensor Roles' },
    { id: 'actuator_roles', label: 'Actuator Roles' },
    { id: 'controller', label: 'Controller' },
    { id: 'phase2', label: 'Phase2' },
    { id: 'calibration', label: 'Calibration' },
    { id: 'pressure_limits', label: 'Pressure Limits' },
    { id: 'display', label: 'Display' },
    { id: 'state_machine', label: 'State Machine' },
    { id: 'advanced', label: 'Advanced JSON' },
  ];

  return (
    <main className="min-h-screen bg-background text-text p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold">Configuration Editor</h1>
          <div className="flex gap-4">
            <button
              onClick={loadConfig}
              disabled={loading || saving}
              className="px-4 py-2 bg-card rounded-lg hover:bg-opacity-80 disabled:opacity-50"
            >
              Reload
            </button>
            <button
              onClick={saveConfig}
              disabled={saving || loading}
              className="px-4 py-2 bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Config'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-4 bg-red-900/30 border border-red-500 rounded-lg text-red-200">
            {error}
          </div>
        )}

        {success && (
          <div className="mb-4 p-4 bg-green-900/30 border border-green-500 rounded-lg text-green-200">
            Configuration saved successfully!
          </div>
        )}

        {/* Tabs */}
        <div className="mb-6 border-b border-gray-700">
          <div className="flex gap-2 overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-text-muted hover:text-text'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab Content */}
        <div className="space-y-6">
          {activeTab === 'system' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">System</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField(
                  'Mode',
                  config.system?.mode,
                  (val) => updateField('system', 'mode', val),
                  'select',
                  ['GROUND', 'FLIGHT']
                )}
                {renderField(
                  'Initial State',
                  config.system?.state,
                  (val) => updateField('system', 'state', val)
                )}
              </div>
            </div>
          )}

          {activeTab === 'network' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Network</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField(
                  'Bind IP',
                  config.network?.bind_ip,
                  (val) => updateField('network', 'bind_ip', val)
                )}
                {renderField(
                  'Sensor Port',
                  config.network?.sensor_port,
                  (val) => updateField('network', 'sensor_port', val),
                  'number'
                )}
                {renderField(
                  'Actuator Command Port',
                  config.network?.actuator_cmd_port,
                  (val) => updateField('network', 'actuator_cmd_port', val),
                  'number'
                )}
                {renderField(
                  'Buffer Size',
                  config.network?.buffer_size,
                  (val) => updateField('network', 'buffer_size', val),
                  'number'
                )}
              </div>
            </div>
          )}

          {activeTab === 'server_heartbeat' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Server Heartbeat</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField(
                  'Interval (ms)',
                  config.server_heartbeat?.interval_ms,
                  (val) => updateField('server_heartbeat', 'interval_ms', val),
                  'number'
                )}
                {renderField(
                  'Broadcast Port',
                  config.server_heartbeat?.broadcast_port,
                  (val) => updateField('server_heartbeat', 'broadcast_port', val),
                  'number'
                )}
                {renderField(
                  'Broadcast IP',
                  config.server_heartbeat?.broadcast_ip,
                  (val) => updateField('server_heartbeat', 'broadcast_ip', val)
                )}
              </div>
            </div>
          )}

          {activeTab === 'database' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Database</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField(
                  'Host',
                  config.database?.host,
                  (val) => updateField('database', 'host', val)
                )}
                {renderField(
                  'Port',
                  config.database?.port,
                  (val) => updateField('database', 'port', val),
                  'number'
                )}
                {renderField(
                  'Auto Flush Interval (ms)',
                  config.database?.auto_flush_interval_ms,
                  (val) => updateField('database', 'auto_flush_interval_ms', val),
                  'number'
                )}
                {renderField(
                  'Max Buffer Size',
                  config.database?.max_buffer_size,
                  (val) => updateField('database', 'max_buffer_size', val),
                  'number'
                )}
                {renderField(
                  'Connection Retry Attempts',
                  config.database?.connection_retry_attempts,
                  (val) => updateField('database', 'connection_retry_attempts', val),
                  'number'
                )}
                {renderField(
                  'Connection Retry Delay (ms)',
                  config.database?.connection_retry_delay_ms,
                  (val) => updateField('database', 'connection_retry_delay_ms', val),
                  'number'
                )}
              </div>
            </div>
          )}

          {activeTab === 'discovery' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Discovery</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField(
                  'Enabled',
                  config.discovery?.enabled,
                  (val) => updateField('discovery', 'enabled', val),
                  'boolean'
                )}
                {renderField(
                  'Network Interface',
                  config.discovery?.network_interface,
                  (val) => updateField('discovery', 'network_interface', val)
                )}
                {renderField(
                  'Mode',
                  config.discovery?.mode,
                  (val) => updateField('discovery', 'mode', val),
                  'select',
                  ['passive', 'active', 'hybrid']
                )}
                {renderField(
                  'Subnet',
                  config.discovery?.subnet,
                  (val) => updateField('discovery', 'subnet', val)
                )}
                {renderField(
                  'IP Range Start',
                  config.discovery?.ip_range_start,
                  (val) => updateField('discovery', 'ip_range_start', val),
                  'number'
                )}
                {renderField(
                  'IP Range End',
                  config.discovery?.ip_range_end,
                  (val) => updateField('discovery', 'ip_range_end', val),
                  'number'
                )}
                {renderField(
                  'Discovery Timeout (seconds)',
                  config.discovery?.discovery_timeout_seconds,
                  (val) => updateField('discovery', 'discovery_timeout_seconds', val),
                  'number'
                )}
              </div>
            </div>
          )}

          {activeTab === 'boards' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Boards</h2>
              <div className="space-y-6">
                {Object.entries(config.boards || {}).map(([boardKey, board]) => (
                  <div key={boardKey} className="border border-gray-700 rounded-lg p-4">
                    <h3 className="text-lg font-semibold mb-3">{boardKey}</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {renderField(
                        'Type',
                        (board as any).type,
                        (val) => updateBoard(boardKey, 'type', val),
                        'select',
                        ['PT', 'ACTUATOR', 'LC', 'TC', 'RTD']
                      )}
                      {renderField(
                        'IP',
                        (board as any).ip,
                        (val) => updateBoard(boardKey, 'ip', val)
                      )}
                      {renderField(
                        'Send Port',
                        (board as any).send_port,
                        (val) => updateBoard(boardKey, 'send_port', val),
                        'number'
                      )}
                      {(board as any).listen_port !== undefined && renderField(
                        'Listen Port',
                        (board as any).listen_port,
                        (val) => updateBoard(boardKey, 'listen_port', val),
                        'number'
                      )}
                      {renderField(
                        'Board ID',
                        (board as any).board_id,
                        (val) => updateBoard(boardKey, 'board_id', val),
                        'number'
                      )}
                      {renderField(
                        'Enabled',
                        (board as any).enabled,
                        (val) => updateBoard(boardKey, 'enabled', val),
                        'boolean'
                      )}
                      {renderField(
                        'Enable serial printing',
                        (board as any).enable_serial_printing,
                        (val) => updateBoard(boardKey, 'enable_serial_printing', val),
                        'boolean',
                        undefined,
                        'Board will enable serial debug when config is applied'
                      )}
                      {(board as any).necessary_for_abort !== undefined && renderField(
                        'Necessary for abort',
                        (board as any).necessary_for_abort,
                        (val) => updateBoard(boardKey, 'necessary_for_abort', val),
                        'boolean'
                      )}
                      {(board as any).designated_survivor !== undefined && renderField(
                        'Designated survivor (actuator only)',
                        (board as any).designated_survivor,
                        (val) => updateBoard(boardKey, 'designated_survivor', val),
                        'boolean'
                      )}
                      <div className="space-y-1">
                        <label className="block text-sm font-semibold">Voltage reference</label>
                        <select
                          value={String((board as any).voltage_reference ?? 0)}
                          onChange={(e) => updateBoard(boardKey, 'voltage_reference', parseInt(e.target.value, 10))}
                          className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white"
                        >
                          <option value="0">Internal (2.5V)</option>
                          <option value="1">VDD (ratiometric)</option>
                          <option value="2">5V (absolute)</option>
                        </select>
                      </div>
                      {(board as any).adc_ref_voltage !== undefined && renderField(
                        'ADC Reference Voltage (V)',
                        (board as any).adc_ref_voltage,
                        (val) => updateBoard(boardKey, 'adc_ref_voltage', val),
                        'number'
                      )}
                      {renderField(
                        'Num Sensors',
                        (board as any).num_sensors,
                        (val) => updateBoard(boardKey, 'num_sensors', val),
                        'number'
                      )}
                      {(board as any).num_actuators !== undefined && renderField(
                        'Num Actuators',
                        (board as any).num_actuators,
                        (val) => updateBoard(boardKey, 'num_actuators', val),
                        'number'
                      )}
                      {renderField(
                        'Active Connectors',
                        (board as any).active_connectors,
                        (val) => updateBoard(boardKey, 'active_connectors', val),
                        'array'
                      )}

                      {/* HP PT extras */}
                      {(board as any).hp_pt_connectors !== undefined && renderField(
                        'HP PT Connectors',
                        (board as any).hp_pt_connectors,
                        (val) => updateBoard(boardKey, 'hp_pt_connectors', val),
                        'array'
                      )}
                      {(board as any).excitation_connector_id !== undefined && renderField(
                        'Excitation Connector ID',
                        (board as any).excitation_connector_id,
                        (val) => updateBoard(boardKey, 'excitation_connector_id', val),
                        'number'
                      )}
                      {(board as any).hp_pt_full_scale_psi !== undefined && renderField(
                        'HP PT Full Scale (PSI)',
                        (board as any).hp_pt_full_scale_psi,
                        (val) => updateBoard(boardKey, 'hp_pt_full_scale_psi', val),
                        'number'
                      )}
                      {(board as any).hp_pt_sense_resistor_ohms !== undefined && renderField(
                        'HP PT Sense Resistor (Ω)',
                        (board as any).hp_pt_sense_resistor_ohms,
                        (val) => updateBoard(boardKey, 'hp_pt_sense_resistor_ohms', val),
                        'number'
                      )}
                      {(board as any).excitation_divider_attenuation !== undefined && renderField(
                        'Excitation Divider Attenuation',
                        (board as any).excitation_divider_attenuation,
                        (val) => updateBoard(boardKey, 'excitation_divider_attenuation', val),
                        'number'
                      )}
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => {
                    const newKey = `board_${Object.keys(config.boards || {}).length + 1}`;
                    updateBoard(newKey, 'type', 'PT');
                    updateBoard(newKey, 'enabled', false);
                    updateBoard(newKey, 'enable_serial_printing', false);
                    updateBoard(newKey, 'voltage_reference', 0);
                  }}
                  className="px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600"
                >
                  + Add Board
                </button>
              </div>
            </div>
          )}

          {activeTab === 'sensor_roles' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Sensor Roles</h2>
              <div className="space-y-8">
                {([
                  { key: 'sensor_roles_pt_board', title: 'PT Board Roles (sensor_roles_pt_board)' },
                  { key: 'sensor_roles_pt2', title: 'HP PT Roles (sensor_roles_pt2)' },
                ] as const).map(({ key, title }) => {
                  const map = (config as any)[key] as Record<string, number> | undefined;
                  const entries = Object.entries(map || {});
                  return (
                    <div key={key} className="space-y-4">
                      <h3 className="text-lg font-semibold">{title}</h3>
                      {entries.length === 0 && (
                        <p className="text-sm text-text-muted">
                          No entries. Add one to create this section in `config.toml`.
                        </p>
                      )}
                      <div className="space-y-3">
                        {entries.map(([name, sensorId]) => (
                          <div key={`${key}:${name}`} className="flex items-center gap-4">
                            <input
                              type="text"
                              value={name}
                              onChange={(e) => {
                                const updated = { ...(map || {}) };
                                delete updated[name];
                                updated[e.target.value] = sensorId;
                                setConfig({ ...config, [key]: updated } as any);
                              }}
                              className="flex-1 px-3 py-2 bg-background border border-gray-700 rounded text-white"
                            />
                            <span className="text-text-muted">=</span>
                            <input
                              type="number"
                              value={sensorId ?? ''}
                              onChange={(e) => {
                                const raw = e.target.value;
                                const updated = { ...(map || {}) };
                                if (raw === '') return;
                                updated[name] = parseInt(raw, 10);
                                setConfig({ ...config, [key]: updated } as any);
                              }}
                              className="w-28 px-3 py-2 bg-background border border-gray-700 rounded text-white"
                            />
                            <button
                              onClick={() => {
                                const updated = { ...(map || {}) };
                                delete updated[name];
                                setConfig({ ...config, [key]: updated } as any);
                              }}
                              className="px-3 py-2 bg-red-600 rounded hover:bg-red-700"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        onClick={() => {
                          const updated = { ...(map || {}) };
                          updated['New Sensor'] = 1;
                          setConfig({ ...config, [key]: updated } as any);
                        }}
                        className="px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600"
                      >
                        + Add Role
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === 'actuator_roles' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Actuator Roles</h2>
              <div className="space-y-4">
                {Object.entries(config.actuator_roles || {}).map(([name, value]) => {
                  const arr = Array.isArray(value) ? value : [];
                  const type = (arr[0] as string) || 'NC';
                  const actuatorId = typeof arr[1] === 'number' ? arr[1] : Number(arr[1] || 1);
                  const third = arr.length >= 3 ? arr[2] : undefined;
                  const boardId = typeof third === 'number' ? third : (typeof third === 'string' ? Number(third) : undefined);
                  return (
                  <div key={name} className="flex items-center gap-4">
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => {
                        const updated = { ...config.actuator_roles };
                        delete updated[name];
                        updated[e.target.value] = third !== undefined ? ([type, actuatorId, third] as any) : ([type, actuatorId] as any);
                        setConfig({ ...config, actuator_roles: updated });
                      }}
                      className="flex-1 px-3 py-2 bg-background border border-gray-700 rounded text-white"
                    />
                    <span className="text-text-muted">=</span>
                    <select
                      value={type}
                      onChange={(e) => {
                        const updated = { ...config.actuator_roles };
                        updated[name] = third !== undefined
                          ? ([e.target.value, actuatorId, third] as any)
                          : ([e.target.value, actuatorId] as any);
                        setConfig({ ...config, actuator_roles: updated });
                      }}
                      className="px-3 py-2 bg-background border border-gray-700 rounded text-white"
                    >
                      <option value="NO">NO (Normally Open)</option>
                      <option value="NC">NC (Normally Closed)</option>
                    </select>
                    <input
                      type="number"
                      value={actuatorId}
                      onChange={(e) => {
                        const updated = { ...config.actuator_roles };
                        const ch = parseInt(e.target.value, 10);
                        updated[name] = third !== undefined ? ([type, ch, third] as any) : ([type, ch] as any);
                        setConfig({ ...config, actuator_roles: updated });
                      }}
                      className="w-24 px-3 py-2 bg-background border border-gray-700 rounded text-white"
                      placeholder="ID"
                    />
                    <input
                      type="number"
                      value={Number.isFinite(boardId as number) ? (boardId as number) : ''}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const updated = { ...config.actuator_roles };
                        if (raw === '') {
                          updated[name] = [type, actuatorId] as any;
                        } else {
                          updated[name] = [type, actuatorId, parseInt(raw, 10)] as any;
                        }
                        setConfig({ ...config, actuator_roles: updated });
                      }}
                      className="w-32 px-3 py-2 bg-background border border-gray-700 rounded text-white"
                      placeholder="Board ID"
                    />
                    <button
                      onClick={() => {
                        const updated = { ...config.actuator_roles };
                        delete updated[name];
                        setConfig({ ...config, actuator_roles: updated });
                      }}
                      className="px-3 py-2 bg-red-600 rounded hover:bg-red-700"
                    >
                      Remove
                    </button>
                  </div>
                  );
                })}
                <button
                  onClick={() => {
                    const updated = { ...config.actuator_roles };
                    updated['New Actuator'] = ['NC', 1, 12] as any;
                    setConfig({ ...config, actuator_roles: updated });
                  }}
                  className="px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600"
                >
                  + Add Actuator Role
                </button>
              </div>
            </div>
          )}

          {activeTab === 'controller' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Controller</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField(
                  'Controller Loop (Hz)',
                  config.controller?.controller_loop_hz,
                  (val) => updateField('controller', 'controller_loop_hz', val),
                  'number'
                )}
                {renderField(
                  'PWM Frequency (Hz)',
                  config.controller?.pwm_frequency_hz,
                  (val) => updateField('controller', 'pwm_frequency_hz', val),
                  'number'
                )}
                {renderField(
                  'PWM Duration (ms)',
                  config.controller?.pwm_duration_ms,
                  (val) => updateField('controller', 'pwm_duration_ms', val),
                  'number'
                )}
                {renderField(
                  'Controller Service URL',
                  config.controller?.controller_service_url,
                  (val) => updateField('controller', 'controller_service_url', val)
                )}
                {renderField(
                  'Controller Config Path',
                  config.controller?.controller_config_path,
                  (val) => updateField('controller', 'controller_config_path', val)
                )}
                {renderField(
                  'Use C++ Controller',
                  config.controller?.use_cpp_controller,
                  (val) => updateField('controller', 'use_cpp_controller', val),
                  'boolean'
                )}
                {renderField(
                  'Command Type',
                  config.controller?.command_type,
                  (val) => updateField('controller', 'command_type', val),
                  'select',
                  ['THRUST_DESIRED', 'ALTITUDE_GOAL', 'PRESSURE_TARGET']
                )}
                {renderField(
                  'Thrust Desired',
                  config.controller?.thrust_desired,
                  (val) => updateField('controller', 'thrust_desired', val),
                  'number'
                )}
                {renderField(
                  'Altitude Goal',
                  config.controller?.altitude_goal,
                  (val) => updateField('controller', 'altitude_goal', val),
                  'number'
                )}
                {renderField(
                  'Fuel Pressure Target',
                  config.controller?.pressure_fuel_target,
                  (val) => updateField('controller', 'pressure_fuel_target', val),
                  'number'
                )}
                {renderField(
                  'Ox Pressure Target',
                  config.controller?.pressure_ox_target,
                  (val) => updateField('controller', 'pressure_ox_target', val),
                  'number'
                )}
              </div>
            </div>
          )}

          {activeTab === 'phase2' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Phase2 (raw object)</h2>
              <p className="text-sm text-text-muted mb-3">
                This section is stored as a TOML table. Edit as JSON here (advanced users).
              </p>
              <textarea
                value={JSON.stringify(config.phase2 || {}, null, 2)}
                onChange={(e) => {
                  try {
                    const obj = JSON.parse(e.target.value || '{}');
                    setConfig({ ...config, phase2: obj });
                  } catch {
                    // ignore until valid JSON
                  }
                }}
                className="w-full h-72 px-3 py-2 bg-background border border-gray-700 rounded text-white font-mono text-xs"
              />
            </div>
          )}

          {activeTab === 'calibration' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Calibration</h2>
              <div className="space-y-6">
                {renderField(
                  'Enabled',
                  config.calibration?.enabled,
                  (val) => updateField('calibration', 'enabled', val),
                  'boolean'
                )}

                <div className="border-t border-gray-700 pt-4">
                  <h3 className="text-lg font-semibold mb-4">Orchestrator Settings</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {renderField(
                      'Min Points',
                      config.calibration?.orchestrator?.min_points,
                      (val) => updateField('calibration', 'min_points', val, 'orchestrator'),
                      'number'
                    )}
                    {renderField(
                      'Target Points',
                      config.calibration?.orchestrator?.target_points,
                      (val) => updateField('calibration', 'target_points', val, 'orchestrator'),
                      'number'
                    )}
                    {renderField(
                      'Max Points',
                      config.calibration?.orchestrator?.max_points,
                      (val) => updateField('calibration', 'max_points', val, 'orchestrator'),
                      'number'
                    )}
                    {renderField(
                      'Min R²',
                      config.calibration?.orchestrator?.min_r_squared,
                      (val) => updateField('calibration', 'min_r_squared', val, 'orchestrator'),
                      'number'
                    )}
                    {renderField(
                      'Target R²',
                      config.calibration?.orchestrator?.target_r_squared,
                      (val) => updateField('calibration', 'target_r_squared', val, 'orchestrator'),
                      'number'
                    )}
                    {renderField(
                      'RLS Forgetting Factor',
                      config.calibration?.orchestrator?.rls_forgetting_factor,
                      (val) => updateField('calibration', 'rls_forgetting_factor', val, 'orchestrator'),
                      'number'
                    )}
                    {renderField(
                      'Drift GLR Threshold',
                      config.calibration?.orchestrator?.drift_glr_threshold,
                      (val) => updateField('calibration', 'drift_glr_threshold', val, 'orchestrator'),
                      'number'
                    )}
                    {renderField(
                      'Auto Save Interval (sec)',
                      config.calibration?.orchestrator?.auto_save_interval_sec,
                      (val) => updateField('calibration', 'auto_save_interval_sec', val, 'orchestrator'),
                      'number'
                    )}
                    {renderField(
                      'Status Interval (sec)',
                      config.calibration?.orchestrator?.status_interval_sec,
                      (val) => updateField('calibration', 'status_interval_sec', val, 'orchestrator'),
                      'number'
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'pressure_limits' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Pressure Limits</h2>
              <div className="space-y-6">
                {['GN2', 'ETH', 'LOX'].map((system) => (
                  <div key={system} className="border border-gray-700 rounded-lg p-4">
                    <h3 className="text-lg font-semibold mb-3">{system}</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      {renderField(
                        'THRESH',
                        config.pressure_limits?.[system]?.THRESH,
                        (val) => updateField('pressure_limits', 'THRESH', val, system),
                        'number'
                      )}
                      {renderField(
                        'NOP',
                        config.pressure_limits?.[system]?.NOP,
                        (val) => updateField('pressure_limits', 'NOP', val, system),
                        'number'
                      )}
                      {renderField(
                        'MEOP',
                        config.pressure_limits?.[system]?.MEOP,
                        (val) => updateField('pressure_limits', 'MEOP', val, system),
                        'number'
                      )}
                      {renderField(
                        'POP',
                        config.pressure_limits?.[system]?.POP,
                        (val) => updateField('pressure_limits', 'POP', val, system),
                        'number'
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'display' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Display Settings</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField(
                  'ADC Bits',
                  config.display?.adc_bits,
                  (val) => updateField('display', 'adc_bits', val),
                  'number'
                )}
                {renderField(
                  'Window Seconds',
                  config.display?.window_seconds,
                  (val) => updateField('display', 'window_seconds', val),
                  'number'
                )}
                {renderField(
                  'Y Axis Min',
                  config.display?.y_axis_min,
                  (val) => updateField('display', 'y_axis_min', val),
                  'number'
                )}
                {renderField(
                  'Y Axis Max',
                  config.display?.y_axis_max,
                  (val) => updateField('display', 'y_axis_max', val),
                  'number'
                )}
                {renderField(
                  'Y Axis Autoscale',
                  config.display?.y_axis_autoscale,
                  (val) => updateField('display', 'y_axis_autoscale', val),
                  'boolean'
                )}
                {renderField(
                  'Only Show Actuators With Roles',
                  config.display?.only_show_actuators_with_roles,
                  (val) => updateField('display', 'only_show_actuators_with_roles', val),
                  'boolean'
                )}
                {renderField(
                  'Only Show PT With Roles',
                  config.display?.only_show_pt_with_roles,
                  (val) => updateField('display', 'only_show_pt_with_roles', val),
                  'boolean'
                )}
                {renderField(
                  'Graph MA Samples',
                  config.display?.graph_ma_samples,
                  (val) => updateField('display', 'graph_ma_samples', val),
                  'number'
                )}
                {renderField(
                  'Display MA Samples',
                  config.display?.display_ma_samples,
                  (val) => updateField('display', 'display_ma_samples', val),
                  'number'
                )}
              </div>
            </div>
          )}

          {activeTab === 'state_machine' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">State Machine</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField(
                  'Actuator CSV',
                  config.state_machine?.actuator_csv,
                  (val) => updateField('state_machine', 'actuator_csv', val)
                )}
                {renderField(
                  'Transitions CSV',
                  config.state_machine?.transitions_csv,
                  (val) => updateField('state_machine', 'transitions_csv', val)
                )}
              </div>
            </div>
          )}

          {activeTab === 'advanced' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-2">Advanced JSON</h2>
              <p className="text-sm text-text-muted mb-4">
                Full config object as JSON. This is an escape hatch for fields not yet covered by the form tabs.
              </p>
              {advancedError && (
                <div className="mb-3 p-3 bg-red-900/30 border border-red-500 rounded text-red-200 text-sm">
                  {advancedError}
                </div>
              )}
              <textarea
                value={advancedText}
                onChange={(e) => {
                  setAdvancedText(e.target.value);
                  setAdvancedError(null);
                }}
                className="w-full h-[520px] px-3 py-2 bg-background border border-gray-700 rounded text-white font-mono text-xs"
              />
              <div className="mt-4 flex gap-3">
                <button
                  onClick={() => {
                    try {
                      const obj = JSON.parse(advancedText || '{}');
                      setConfig(obj);
                      setAdvancedError(null);
                    } catch (e: any) {
                      setAdvancedError(e?.message || 'Invalid JSON');
                    }
                  }}
                  className="px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600"
                >
                  Apply JSON to Form
                </button>
                <button
                  onClick={() => {
                    setAdvancedText(JSON.stringify(config || {}, null, 2));
                    setAdvancedError(null);
                  }}
                  className="px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600"
                >
                  Reset to Current Form
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 text-sm text-text-muted">
          <p className="mb-2">⚠️ <strong>Warning:</strong> Editing configuration can affect system behavior.</p>
          <p>Changes will be applied after saving. Some changes may require system restart.</p>
        </div>
      </div>
    </main>
  );
}
