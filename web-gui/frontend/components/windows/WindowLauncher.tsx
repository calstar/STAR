'use client'

import { useWindowManager } from './WindowManager';

interface WindowButtonProps {
  id: string;
  name: string;
  description: string;
  url: string;
  accent: string;
}

function WindowButton({ id, name, description, url, accent }: WindowButtonProps) {
  const { openWindow, windows } = useWindowManager();
  const isOpen = windows.some((w) => w.id === id && w.window && !w.window.closed);

  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        const result = openWindow(id, name, url, 1400, 900);
        if (!result) {
          console.warn(`[WindowLauncher] Failed to open ${name} - check popup blocker`);
        }
      }}
      className={`
        relative overflow-hidden bg-card rounded-lg border transition-all text-left
        hover:border-gray-500 hover:bg-opacity-80
        ${isOpen ? 'border-gray-500 ring-1 ring-inset ring-gray-600' : 'border-gray-800'}
      `}
    >
      <div className="absolute left-0 top-0 bottom-0 w-1.5 rounded-l-lg" style={{ backgroundColor: accent }} />
      <div className="px-4 py-3 pl-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-text">{name}</span>
          {isOpen && (
            <span className="text-xs font-mono text-green-400 flex-shrink-0">● OPEN</span>
          )}
        </div>
        <div className="text-xs text-text-muted mt-1 leading-snug line-clamp-2">{description}</div>
      </div>
    </button>
  );
}

export default function WindowLauncher() {
  const { closeAllWindows, windows } = useWindowManager();
  const openCount = windows.filter((w) => w.window && !w.window.closed).length;

  const allPlotsEntry: WindowButtonProps = {
    id: 'all', name: 'All Plots ★',
    description: 'FUEL · LOX · COPV · GSE · RAW in one tabbed window',
    url: '/window/all', accent: '#38BDF8',
  };

  const unifiedEntry: WindowButtonProps = {
    id: 'unified', name: 'Single Pane ★★',
    description: 'State machine · Pressure graphs · Actuators · Controller all in one window',
    url: '/window/unified', accent: '#EC4899',
  };

  const multiEntries: WindowButtonProps[] = [
    { id: 'fuel',        name: 'FUEL',         description: 'Upstream / downstream pressure & actuators', url: '/window/fuel',        accent: '#3498DB' },
    { id: 'lox',         name: 'LOX',          description: 'Oxidizer pressure & actuators',              url: '/window/lox',         accent: '#E74C3C' },
    { id: 'copv',        name: 'COPV / GN2',   description: 'High-pressure bottle & regulator',           url: '/window/copv',        accent: '#27AE60' },
    { id: 'gse',         name: 'GSE',          description: 'Ground support equipment pressures',         url: '/window/gse',         accent: '#F39C12' },
    { id: 'raw',         name: 'Raw ADC',      description: 'All 10 PT & actuator ADC channels',          url: '/window/raw',         accent: '#60A5FA' },
    { id: 'controls',    name: 'Controls',     description: 'State machine & actuator commands',          url: '/window/controls',    accent: '#A78BFA' },
    { id: 'status',      name: 'Status',       description: 'Tabular real-time sensor values',            url: '/window/status',      accent: '#34D399' },
    { id: 'boards',      name: 'Boards / Heartbeats', description: 'Discovered boards and heartbeat status', url: '/window/boards',    accent: '#10B981' },
    { id: 'config',      name: 'Config',       description: 'System & board configuration editor',        url: '/window/config',      accent: '#FBBF24' },
    { id: 'controller',  name: 'Controller',   description: 'PWM duty cycle & valve states',              url: '/window/controller',  accent: '#F87171' },
    { id: 'calibration', name: 'Calibration',  description: 'RLS + GLR drift · Bayesian auto-recal',     url: '/window/calibration', accent: '#A3E635' },
    { id: 'lcs-tcs-rtd',  name: 'LCS / TCS / RTD', description: 'Thermocouples, RTDs, load cell — voltage and temperature', url: '/window/lcs-tcs-rtd', accent: '#F59E0B' },
    { id: 'sensor-info',  name: 'Sensor Info',     description: 'ADC code · converted value · data rate per channel for all PT / HPT / TC / RTD / LC', url: '/window/sensor-info', accent: '#22D3EE' },
  ];

  return (
    <div className="bg-card rounded-lg border border-gray-800 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-bold tracking-wider text-text-muted uppercase">View Windows</h2>
          {openCount > 0 && (
            <span className="text-xs text-text-muted">{openCount} window{openCount !== 1 ? 's' : ''} open</span>
          )}
        </div>
        {openCount > 0 && (
          <button
            onClick={closeAllWindows}
            className="px-3 py-1.5 bg-red-900/40 border border-red-800 rounded text-xs font-semibold text-red-300 hover:bg-red-800/60 transition-colors"
          >
            Close All
          </button>
        )}
      </div>

      {/* Featured windows */}
      <div className="mb-2 space-y-2">
        <WindowButton {...unifiedEntry} />
        <WindowButton {...allPlotsEntry} />
      </div>

      {/* Grid - 2 rows */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {multiEntries.map((e) => (
          <WindowButton key={e.id} {...e} />
        ))}
      </div>
    </div>
  );
}
