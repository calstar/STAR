'use client'

import { useState, useEffect } from 'react';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType } from '@/lib/types';

interface ConfigData {
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
  sensor_roles?: Record<string, number>;
  actuator_roles?: Record<string, [string, number]>;
  actuator_abbrev?: Record<string, string>;
  routing?: Record<string, any>;
  calibration?: any;
  pressure_limits?: Record<string, any>;
  pressure_mappings?: Record<string, number>;
  display?: Record<string, any>;
  state_machine?: Record<string, string>;
}

// Sensible defaults drawn from config.toml so the form isn't blank on first load
const DEFAULT_CONFIG: ConfigData = {
  system:   { mode: 'GROUND', state: 'GSE' },
  network:  { bind_ip: '0.0.0.0', sensor_port: 5006, actuator_cmd_port: 5005, buffer_size: 1024 },
  database: { host: '127.0.0.1', port: 2240, auto_flush_interval_ms: 100,
              max_buffer_size: 4096, connection_retry_attempts: 3, connection_retry_delay_ms: 1000 },
  discovery:{ enabled: true, network_interface: 'auto', mode: 'hybrid',
              subnet: '192.168.2.0/24', ip_range_start: 100, ip_range_end: 150,
              discovery_timeout_seconds: 30 },
  boards: {
    pt_board: { type: 'PT', ip: '192.168.2.101', send_port: 5006, num_sensors: 10, board_id: 1, enabled: true, voltage_reference: 0, active_connectors: [1,2,3,4,5,6,7] },
    actuator_board: { type: 'ACTUATOR', ip: '192.168.2.201', send_port: 5006, listen_port: 5005, num_actuators: 10, num_sensors: 10, board_id: 2, enabled: true, voltage_reference: 0, active_connectors: [] },
  },
  sensor_roles: { 'Fuel Upstream': 1, 'GSE Low': 2, 'GSE Mid': 3, 'Fuel Downstream': 4, 'Ox Upstream': 5, 'GN2 Regulated': 6, 'Ox Downstream': 7 },
  actuator_roles: { 'LOX Main': ['NO', 1], 'Fuel Vent': ['NC', 2], 'Fuel Press': ['NC', 3], 'GSE Low Vent': ['NC', 5], 'LOX Vent': ['NC', 6], 'Fuel Main': ['NO', 7], 'LOX Press': ['NO', 8] },
  calibration: { enabled: true, orchestrator: { min_points: 5, target_points: 15, max_points: 30, min_r_squared: 0.95, target_r_squared: 0.99, rls_forgetting_factor: 0.995, drift_glr_threshold: 3.0, auto_save_interval_sec: 300, status_interval_sec: 30 } },
  pressure_limits: { GN2: { THRESH: 550, NOP: 900, MEOP: 950, POP: 1000 }, ETH: { THRESH: 550, NOP: 600, MEOP: 650, POP: 750 }, LOX: { THRESH: 550, NOP: 600, MEOP: 650, POP: 750 } },
  display: { adc_bits: 32, window_seconds: 26.0, y_axis_min: 0.0, y_axis_max: 700.0, y_axis_autoscale: true, only_show_actuators_with_roles: true, only_show_pt_with_roles: true, graph_ma_samples: 1, display_ma_samples: 1 },
  state_machine: { actuator_csv: 'external/DiabloAvionics/test_guis/state_machine_actuators.csv', transitions_csv: 'external/DiabloAvionics/test_guis/state_transitions.csv' },
};

export default function ConfigPage() {
  const [config, setConfig] = useState<ConfigData>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [activeTab, setActiveTab] = useState('system');

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
      // Merge loaded config on top of defaults so fields are never empty
      setConfig({ ...DEFAULT_CONFIG, ...(data.config || {}) });
      setLoading(false);
    } catch (err: any) {
      // Keep defaults even on error so form is usable offline
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
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to save config');
      setSaving(false);
    }
  };

  const updateField = (section: string, field: string, value: any, subSection?: string) => {
    setConfig((prev) => {
      const updated = { ...prev };
      if (subSection) {
        if (!updated[section as keyof ConfigData]) {
          (updated as any)[section] = {};
        }
        if (!(updated as any)[section][subSection]) {
          (updated as any)[section][subSection] = {};
        }
        (updated as any)[section][subSection][field] = value;
      } else {
        if (!updated[section as keyof ConfigData]) {
          (updated as any)[section] = {};
        }
        (updated as any)[section][field] = value;
      }
      return updated;
    });
  };

  const updateBoard = (boardKey: string, field: string, value: any) => {
    setConfig((prev) => {
      const updated = { ...prev };
      if (!updated.boards) {
        updated.boards = {};
      }
      if (!updated.boards[boardKey]) {
        updated.boards[boardKey] = {};
      }
      updated.boards[boardKey][field] = value;
      return updated;
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
              checked={value || false}
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
            value={value || 0}
            onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
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
    { id: 'database', label: 'Database' },
    { id: 'discovery', label: 'Discovery' },
    { id: 'boards', label: 'Boards' },
    { id: 'sensor_roles', label: 'Sensor Roles' },
    { id: 'actuator_roles', label: 'Actuator Roles' },
    { id: 'calibration', label: 'Calibration' },
    { id: 'pressure_limits', label: 'Pressure Limits' },
    { id: 'display', label: 'Display' },
    { id: 'state_machine', label: 'State Machine' },
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
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => {
                    const newKey = `board_${Object.keys(config.boards || {}).length + 1}`;
                    updateBoard(newKey, 'type', 'PT');
                    updateBoard(newKey, 'enabled', false);
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
              <div className="space-y-4">
                {Object.entries(config.sensor_roles || {}).map(([name, sensorId]) => (
                  <div key={name} className="flex items-center gap-4">
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => {
                        const updated = { ...config.sensor_roles };
                        delete updated[name];
                        updated[e.target.value] = sensorId;
                        setConfig({ ...config, sensor_roles: updated });
                      }}
                      className="flex-1 px-3 py-2 bg-background border border-gray-700 rounded text-white"
                    />
                    <span className="text-text-muted">=</span>
                    <input
                      type="number"
                      value={sensorId}
                      onChange={(e) => {
                        const updated = { ...config.sensor_roles };
                        updated[name] = parseInt(e.target.value, 10);
                        setConfig({ ...config, sensor_roles: updated });
                      }}
                      className="w-24 px-3 py-2 bg-background border border-gray-700 rounded text-white"
                    />
                    <button
                      onClick={() => {
                        const updated = { ...config.sensor_roles };
                        delete updated[name];
                        setConfig({ ...config, sensor_roles: updated });
                      }}
                      className="px-3 py-2 bg-red-600 rounded hover:bg-red-700"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => {
                    const updated = { ...config.sensor_roles };
                    updated['New Sensor'] = 1;
                    setConfig({ ...config, sensor_roles: updated });
                  }}
                  className="px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600"
                >
                  + Add Sensor Role
                </button>
              </div>
            </div>
          )}

          {activeTab === 'actuator_roles' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Actuator Roles</h2>
              <div className="space-y-4">
                {Object.entries(config.actuator_roles || {}).map(([name, [type, actuatorId]]) => (
                  <div key={name} className="flex items-center gap-4">
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => {
                        const updated = { ...config.actuator_roles };
                        delete updated[name];
                        updated[e.target.value] = [type, actuatorId];
                        setConfig({ ...config, actuator_roles: updated });
                      }}
                      className="flex-1 px-3 py-2 bg-background border border-gray-700 rounded text-white"
                    />
                    <span className="text-text-muted">=</span>
                    <select
                      value={type}
                      onChange={(e) => {
                        const updated = { ...config.actuator_roles };
                        updated[name] = [e.target.value, actuatorId];
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
                        updated[name] = [type, parseInt(e.target.value, 10)];
                        setConfig({ ...config, actuator_roles: updated });
                      }}
                      className="w-24 px-3 py-2 bg-background border border-gray-700 rounded text-white"
                      placeholder="ID"
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
                ))}
                <button
                  onClick={() => {
                    const updated = { ...config.actuator_roles };
                    updated['New Actuator'] = ['NO', 1];
                    setConfig({ ...config, actuator_roles: updated });
                  }}
                  className="px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600"
                >
                  + Add Actuator Role
                </button>
              </div>
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
        </div>

        <div className="mt-6 text-sm text-text-muted">
          <p className="mb-2">⚠️ <strong>Warning:</strong> Editing configuration can affect system behavior.</p>
          <p>Changes will be applied after saving. Some changes may require system restart.</p>
        </div>
      </div>
    </main>
  );
}
