'use client'

import { useState, useEffect, useRef } from 'react';
import { getWebSocketClient, getApiBaseUrl } from '@/lib/websocket';
import { MessageType } from '@/lib/types';
import { useControlMode } from '@/lib/control-mode';
import { useSensorStore } from '@/lib/store';
import { NAV_ITEMS, navItemById } from '@/lib/nav-items';

interface ConfigData {
  server_heartbeat?: {
    interval_ms?: number;
    broadcast_port?: number;
    broadcast_ip?: string;
  };
  heartbeat_service?: {
    enabled?: boolean;
    backend_url?: string;
    interval_ms?: number;
    broadcast_ip?: string;
    broadcast_port?: number;
  };
  config_broadcast_service?: {
    enabled?: boolean;
    backend_url?: string;
    interval_ms?: number;
  };
  data_logger_service?: {
    enabled?: boolean;
    ws_url?: string;
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
  sensor_roles_rtd_board?: Record<string, number>;
  sensor_roles_tc_board?: Record<string, number>;
  abort_pts?: Record<string, number>;
  adc?: { internal_v?: number; vdd_nominal_v?: number; absolute_5v_v?: number };
  actuator_roles?: Record<string, [string, number] | [string, number, number] | [string, number, string]>;
  actuator_abbrev?: Record<string, string>;
  actuator_service?: { port?: number; bind_address?: string };
  controller_service?: { port?: number; fire_duration_ms?: number; fire_extended_ms?: number };
  routing?: Record<string, any>;
  daq_bridge?: { publish?: string[] };
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
  gui?: {
    downsample_mode?: string;
    points_per_second?: number;
    tabs?: string[];
    pressure_bars?: Array<{ label?: string; role?: string; avg_roles?: string[]; limits?: string; color?: string }>;
  };
}

// Keep defaults minimal: config.toml is the source of truth.
const DEFAULT_CONFIG: ConfigData = {};

export default function ConfigPage() {
  const [config, setConfig] = useState<ConfigData>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [activeTab, setActiveTab] = useState('network');
  const [advancedText, setAdvancedText] = useState('');
  const [advancedError, setAdvancedError] = useState<string | null>(null);

  const ws = getWebSocketClient();
  // Config editing is gated on operator identity (the DAQ allowlist), enforced
  // server-side too. Non-operators see every field greyed out and read-only.
  const { isOperator } = useControlMode();
  const canEdit = isOperator;

  useEffect(() => {
    loadConfig();

    const unsubConn = ws.on(MessageType.CONNECTION_STATUS, () => {});
    const unsubConfig = ws.on(MessageType.CONFIG_UPDATED, () => {
      loadConfig();
    });

    return () => {
      unsubConn();
      unsubConfig();
    };
  }, [ws]);

  const loadConfig = async () => {
    try {
      setLoading(true);
      setError(null);

      // Request config straight from the backend — the Next.js proxy route is gone.
      // getApiBaseUrl() resolves to :8081 directly, or same-origin behind Caddy.
      const response = await fetch(`${getApiBaseUrl()}/api/config`);
      if (!response.ok) {
        throw new Error('Failed to load config');
      }

      const data = await response.json();
      // config.toml is canonical; don't overlay stale defaults
      const nextConfig = (data.config || {}) as ConfigData;
      setConfig(nextConfig);
      const adc = nextConfig.adc;
      if (adc && typeof adc.internal_v === 'number' && typeof adc.absolute_5v_v === 'number') {
        useSensorStore.getState().setVoltageRefNominals({ internalV: adc.internal_v, absolute5vV: adc.absolute_5v_v });
      }
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

      const response = await fetch(`${getApiBaseUrl()}/api/config`, {
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

  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Download the raw config.toml from the server as a file.
  const downloadConfig = () => {
    const a = document.createElement('a');
    a.href = `${getApiBaseUrl()}/api/config/export`;
    a.download = 'config.toml';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // Upload a config.toml to replace the current one (operators only, server-validated).
  const importConfig = async (file: File) => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(false);
      const text = await file.text();
      const response = await fetch(`${getApiBaseUrl()}/api/config/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Import failed (${response.status})`);
      }
      setSuccess(true);
      await loadConfig(); // mirror what the server accepted
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to import config');
    } finally {
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

  // ── [gui] helpers: tab list + top-bar pressure bars ──────────────────────────
  const guiTabs: string[] = config.gui?.tabs ?? [];
  const guiBars = config.gui?.pressure_bars ?? [];

  const setGuiTabs = (tabsList: string[]) =>
    setConfig((prev) => ({ ...prev, gui: { ...(prev.gui || {}), tabs: tabsList } }));
  const setGuiBars = (bars: any[]) =>
    setConfig((prev) => ({ ...prev, gui: { ...(prev.gui || {}), pressure_bars: bars } }));

  const moveInArray = <T,>(arr: T[], i: number, dir: -1 | 1): T[] => {
    const j = i + dir;
    if (j < 0 || j >= arr.length) return arr;
    const next = arr.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
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
    description?: string,
    // Always disabled, even for operators — for startup-only infra that must not
    // be edited from the live GUI (e.g. network ports the pipeline binds at launch).
    readOnly?: boolean
  ) => {
    const fieldDisabled = !canEdit || readOnly;
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
            disabled={fieldDisabled}
            className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
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
              disabled={fieldDisabled}
              className="w-4 h-4 disabled:opacity-50 disabled:cursor-not-allowed"
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
            disabled={fieldDisabled}
            className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
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
            disabled={fieldDisabled}
            className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
          />
        ) : (
          <input
            type="text"
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={fieldDisabled}
            className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
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
    { id: 'network', label: 'Network' },
    { id: 'adc', label: 'ADC' },
    { id: 'server_heartbeat', label: 'Server Heartbeat' },
    { id: 'services', label: 'Services' },
    { id: 'database', label: 'Database' },
    { id: 'discovery', label: 'Discovery' },
    { id: 'boards', label: 'Boards' },
    { id: 'sensor_roles', label: 'Sensor Roles' },
    { id: 'actuator_roles', label: 'Actuator Roles' },
    { id: 'controller', label: 'Controller' },
    { id: 'controller_service', label: 'Controller Service' },
    { id: 'actuator_service', label: 'Actuator Service' },
    { id: 'pressure_limits', label: 'Pressure Limits' },
    { id: 'gui', label: 'Top Bar & Tabs' },
    { id: 'state_machine', label: 'State Machine' },
    { id: 'advanced', label: 'Advanced JSON' },
  ];

  return (
    <main className="min-h-screen bg-background text-text p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold">Configuration Editor</h1>
            <p className="text-sm text-text-muted mt-1">
              Config auto-refreshes when saved (yours or another client). Reload to fetch latest from disk.
            </p>
          </div>
          <div className="flex gap-4">
            <button
              onClick={loadConfig}
              disabled={loading || saving}
              className="px-4 py-2 bg-card rounded-lg hover:bg-opacity-80 disabled:opacity-50"
            >
              Reload
            </button>
            <button
              onClick={downloadConfig}
              className="px-4 py-2 bg-card rounded-lg hover:bg-opacity-80"
              title="Download config.toml"
            >
              Download
            </button>
            <button
              onClick={() => uploadInputRef.current?.click()}
              disabled={!canEdit || saving}
              className="px-4 py-2 bg-card rounded-lg hover:bg-opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              title={canEdit ? 'Upload a config.toml to replace the current one' : 'Operators only'}
            >
              Upload
            </button>
            <input
              ref={uploadInputRef}
              type="file"
              accept=".toml,text/plain"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) importConfig(f); e.target.value = ''; }}
            />
            <button
              onClick={saveConfig}
              disabled={saving || loading || !canEdit}
              className="px-4 py-2 bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
              title={canEdit ? undefined : 'Operators only: config changes disabled'}
            >
              {saving ? 'Saving...' : canEdit ? 'Save Config' : 'Save Disabled (Read-only)'}
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

        {!canEdit && (
          <div className="mb-4 p-3 bg-yellow-900/40 border border-yellow-600 rounded-lg text-yellow-200 text-sm">
            Read-only — you are not an approved operator. Fields are disabled and saving/uploading is blocked (also enforced server-side).
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

        {/* Tab Content — a disabled fieldset greys out and blocks every control
            inside for non-operators (mirrors the server-side operator gate). */}
        <fieldset disabled={!canEdit} className={`space-y-6 border-0 m-0 p-0 min-w-0${!canEdit ? ' opacity-60' : ''}`}>
          {activeTab === 'network' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-1">Network</h2>
              <p className="text-sm text-amber-300/90 mb-4">
                Read-only — these are startup-only binds for the pipeline services and must match the
                board firmware. Changing them requires a deploy/restart, not a live edit.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField(
                  'Bind IP',
                  config.network?.bind_ip,
                  (val) => updateField('network', 'bind_ip', val),
                  'text', undefined, 'DAQ bridge sensor-socket interface', true
                )}
                {renderField(
                  'Sensor Port',
                  config.network?.sensor_port,
                  (val) => updateField('network', 'sensor_port', val),
                  'number', undefined, 'UDP port boards send sensor data to', true
                )}
                {renderField(
                  'Actuator Command Port',
                  config.network?.actuator_cmd_port,
                  (val) => updateField('network', 'actuator_cmd_port', val),
                  'number', undefined, 'Port boards listen on for actuator commands', true
                )}
              </div>
            </div>
          )}

          {activeTab === 'adc' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">ADC Voltage References</h2>
              <p className="text-sm text-text-muted mb-4">
                Used when voltage_reference = 0 (internal) or 2 (5V absolute). Ref 1 = VDD ratiometric.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField(
                  'Internal (V)',
                  config.adc?.internal_v,
                  (val) => updateField('adc', 'internal_v', val),
                  'number',
                  undefined,
                  'Boards with voltage_reference = 0'
                )}
                {renderField(
                  'VDD Nominal (V)',
                  config.adc?.vdd_nominal_v,
                  (val) => updateField('adc', 'vdd_nominal_v', val),
                  'number',
                  undefined,
                  'Display only; ratiometric boards'
                )}
                {renderField(
                  'Absolute 5V (V)',
                  config.adc?.absolute_5v_v,
                  (val) => updateField('adc', 'absolute_5v_v', val),
                  'number',
                  undefined,
                  'Boards with voltage_reference = 2'
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

          {activeTab === 'services' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Services</h2>
              <div className="space-y-8">
                <div className="border border-gray-700 rounded-lg p-4">
                  <h3 className="text-lg font-semibold mb-3">Heartbeat Service</h3>
                  <p className="text-sm text-text-muted mb-3">
                    Polls backend /api/engine_state, broadcasts SERVER_HEARTBEAT to boards.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {renderField('Enabled', config.heartbeat_service?.enabled, (val) => updateField('heartbeat_service', 'enabled', val), 'boolean')}
                    {renderField('Backend URL', config.heartbeat_service?.backend_url, (val) => updateField('heartbeat_service', 'backend_url', val))}
                    {renderField('Interval (ms)', config.heartbeat_service?.interval_ms, (val) => updateField('heartbeat_service', 'interval_ms', val), 'number')}
                    {renderField('Broadcast IP', config.heartbeat_service?.broadcast_ip, (val) => updateField('heartbeat_service', 'broadcast_ip', val))}
                    {renderField('Broadcast Port', config.heartbeat_service?.broadcast_port, (val) => updateField('heartbeat_service', 'broadcast_port', val), 'number')}
                  </div>
                </div>
                <div className="border border-gray-700 rounded-lg p-4">
                  <h3 className="text-lg font-semibold mb-3">Config Broadcast Service</h3>
                  <p className="text-sm text-text-muted mb-3">
                    Sends ACTUATOR_CONFIG / SENSOR_CONFIG to boards.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {renderField('Enabled', config.config_broadcast_service?.enabled, (val) => updateField('config_broadcast_service', 'enabled', val), 'boolean')}
                    {renderField('Backend URL', config.config_broadcast_service?.backend_url, (val) => updateField('config_broadcast_service', 'backend_url', val))}
                    {renderField('Interval (ms)', config.config_broadcast_service?.interval_ms, (val) => updateField('config_broadcast_service', 'interval_ms', val), 'number')}
                  </div>
                </div>
                <div className="border border-gray-700 rounded-lg p-4">
                  <h3 className="text-lg font-semibold mb-3">Data Logger Service</h3>
                  <p className="text-sm text-text-muted mb-3">
                    Records .sensorlog files; connects to backend WebSocket.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {renderField('Enabled', config.data_logger_service?.enabled, (val) => updateField('data_logger_service', 'enabled', val), 'boolean')}
                    {renderField('WebSocket URL', config.data_logger_service?.ws_url, (val) => updateField('data_logger_service', 'ws_url', val))}
                  </div>
                </div>
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
                          disabled={!canEdit}
                          className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
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
                  { key: 'sensor_roles_rtd_board', title: 'RTD Board Roles (sensor_roles_rtd_board)' },
                  { key: 'sensor_roles_tc_board', title: 'TC Board Roles (sensor_roles_tc_board)' },
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

          {activeTab === 'controller_service' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Controller Service (C++)</h2>
              <p className="text-sm text-text-muted mb-4">
                TCP port for FIRE_START / FIRE_STOP. Backend sends FIRE_START when entering FIRE state.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField('Port', config.controller_service?.port, (val) => updateField('controller_service', 'port', val), 'number')}
                {renderField('Fire Duration (ms)', config.controller_service?.fire_duration_ms, (val) => updateField('controller_service', 'fire_duration_ms', val), 'number')}
                {renderField('Fire Extended (ms)', config.controller_service?.fire_extended_ms, (val) => updateField('controller_service', 'fire_extended_ms', val), 'number')}
              </div>
            </div>
          )}

          {activeTab === 'actuator_service' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Actuator Service (C++)</h2>
              <p className="text-sm text-text-muted mb-4">
                When port is set, backend forwards state transitions here; actuator commands sent by C++.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField('Port', config.actuator_service?.port, (val) => updateField('actuator_service', 'port', val), 'number')}
                {renderField('Bind Address', config.actuator_service?.bind_address, (val) => updateField('actuator_service', 'bind_address', val))}
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

          {activeTab === 'pressure_limits' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-1">Pressure Limits</h2>
              <p className="text-sm text-text-muted mb-4">
                NOP/MEOP/POP per system. These are the single source of truth for gauge thresholds —
                each top-bar gauge points at one of these keys via its <code>limits</code> field (Top Bar &amp; Tabs), and the plots read them too.
              </p>
              <div className="space-y-4">
                {Object.keys(config.pressure_limits || {}).map((system) => (
                  <div key={system} className="border border-gray-700 rounded-lg p-4">
                    <h3 className="text-lg font-semibold mb-3 font-mono">{system}</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      {renderField('THRESH', (config.pressure_limits as any)?.[system]?.THRESH, (val) => updateField('pressure_limits', 'THRESH', val, system), 'number')}
                      {renderField('NOP', (config.pressure_limits as any)?.[system]?.NOP, (val) => updateField('pressure_limits', 'NOP', val, system), 'number')}
                      {renderField('MEOP', (config.pressure_limits as any)?.[system]?.MEOP, (val) => updateField('pressure_limits', 'MEOP', val, system), 'number')}
                      {renderField('POP', (config.pressure_limits as any)?.[system]?.POP, (val) => updateField('pressure_limits', 'POP', val, system), 'number')}
                    </div>
                  </div>
                ))}
                {Object.keys(config.pressure_limits || {}).length === 0 && (
                  <p className="text-sm text-text-muted">No pressure limits defined in config.</p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'gui' && (
            <div className="space-y-6">
              {/* ── Tab bar ──────────────────────────────────────────────── */}
              <div className="bg-card rounded-lg p-6">
                <h2 className="text-xl font-bold mb-1">Tab Bar</h2>
                <p className="text-sm text-text-muted mb-4">
                  Which views are pinned to the header, in order. Others stay reachable via “All Views”.
                </p>
                <div className="space-y-2">
                  {guiTabs.map((id, i) => (
                    <div key={`${id}:${i}`} className="flex items-center gap-2">
                      <span className="w-8 text-text-muted text-sm text-right">{i + 1}.</span>
                      <span className="flex-1 px-3 py-2 bg-background border border-gray-700 rounded">
                        {navItemById(id)?.name ?? id}
                        <span className="text-text-muted text-xs ml-2">({id})</span>
                      </span>
                      <button onClick={() => setGuiTabs(moveInArray(guiTabs, i, -1))} className="px-2 py-2 bg-gray-700 rounded hover:bg-gray-600" title="Move up">↑</button>
                      <button onClick={() => setGuiTabs(moveInArray(guiTabs, i, 1))} className="px-2 py-2 bg-gray-700 rounded hover:bg-gray-600" title="Move down">↓</button>
                      <button onClick={() => setGuiTabs(guiTabs.filter((_, k) => k !== i))} className="px-3 py-2 bg-red-600 rounded hover:bg-red-700">Remove</button>
                    </div>
                  ))}
                  {guiTabs.length === 0 && (
                    <p className="text-sm text-text-muted">No tabs configured — the tab bar falls back to built-in defaults.</p>
                  )}
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) setGuiTabs([...guiTabs, e.target.value]); }}
                    className="px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50"
                  >
                    <option value="">+ Add tab…</option>
                    {NAV_ITEMS.filter((v) => !v.deprecated && !guiTabs.includes(v.id)).map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* ── Top-bar pressure gauges ──────────────────────────────── */}
              <div className="bg-card rounded-lg p-6">
                <h2 className="text-xl font-bold mb-1">Top-Bar Pressure Gauges</h2>
                <p className="text-sm text-text-muted mb-4">
                  Ordered gauges in the header. NOP/MEOP come from the Pressure Limits tab (via the <code>limits</code> key).
                </p>
                <datalist id="pressure-limit-keys">
                  {Object.keys(config.pressure_limits || {}).map((k) => <option key={k} value={k} />)}
                </datalist>
                <div className="space-y-3">
                  {guiBars.map((bar: any, i: number) => {
                    const setBar = (patch: any) => setGuiBars(guiBars.map((b: any, k: number) => (k === i ? { ...b, ...patch } : b)));
                    return (
                      <div key={i} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center border border-gray-800 rounded p-2">
                        <input value={bar.label ?? ''} onChange={(e) => setBar({ label: e.target.value })} placeholder="Label" className="md:col-span-2 px-2 py-1.5 bg-background border border-gray-700 rounded text-white" />
                        <input value={bar.role ?? ''} onChange={(e) => setBar({ role: e.target.value })} placeholder="Sensor role" className="md:col-span-3 px-2 py-1.5 bg-background border border-gray-700 rounded text-white" />
                        <input list="pressure-limit-keys" value={bar.limits ?? ''} onChange={(e) => setBar({ limits: e.target.value })} placeholder="Limits key" className="md:col-span-3 px-2 py-1.5 bg-background border border-gray-700 rounded text-white" />
                        <div className="md:col-span-2 flex items-center gap-1">
                          <input type="color" value={bar.color ?? '#888888'} onChange={(e) => setBar({ color: e.target.value })} className="h-8 w-10 bg-background border border-gray-700 rounded" />
                          <input value={bar.color ?? ''} onChange={(e) => setBar({ color: e.target.value })} placeholder="#RRGGBB" className="flex-1 min-w-0 px-2 py-1.5 bg-background border border-gray-700 rounded text-white" />
                        </div>
                        <div className="md:col-span-2 flex items-center justify-end gap-1">
                          <button onClick={() => setGuiBars(moveInArray(guiBars, i, -1))} className="px-2 py-1.5 bg-gray-700 rounded hover:bg-gray-600" title="Move up">↑</button>
                          <button onClick={() => setGuiBars(moveInArray(guiBars, i, 1))} className="px-2 py-1.5 bg-gray-700 rounded hover:bg-gray-600" title="Move down">↓</button>
                          <button onClick={() => setGuiBars(guiBars.filter((_: any, k: number) => k !== i))} className="px-2 py-1.5 bg-red-600 rounded hover:bg-red-700" title="Remove">✕</button>
                        </div>
                        <input value={(bar.avg_roles ?? []).join(', ')} onChange={(e) => { const parts = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); setBar({ avg_roles: parts.length ? parts : undefined }); }} placeholder="avg roles (optional, comma-separated)" className="md:col-span-12 px-2 py-1.5 bg-background border border-gray-700 rounded text-white" />
                      </div>
                    );
                  })}
                </div>
                <button
                  onClick={() => setGuiBars([...guiBars, { label: 'NEW', role: '', limits: '', color: '#888888' }])}
                  className="mt-4 px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600"
                >
                  + Add Gauge
                </button>
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
                className="w-full h-[60vh] min-h-[320px] max-h-[75vh] px-3 py-2 bg-background border border-gray-700 rounded text-white font-mono text-xs"
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
        </fieldset>

        <div className="mt-6 text-sm text-text-muted">
          <p className="mb-2">⚠️ <strong>Warning:</strong> Editing configuration can affect system behavior.</p>
          <p>Changes will be applied after saving. Some changes may require system restart.</p>
        </div>
      </div>
    </main>
  );
}
