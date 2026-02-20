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
      onClick={() => openWindow(id, name, url, 1400, 900)}
      className={`
        relative overflow-hidden bg-card rounded border transition-all text-left
        hover:border-gray-600
        ${isOpen ? 'border-gray-500 ring-1 ring-inset ring-gray-600' : 'border-gray-800'}
      `}
    >
      <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l" style={{ backgroundColor: accent }} />
      <div className="px-3 py-2 pl-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-text">{name}</span>
          {isOpen && (
            <span className="text-[10px] font-mono text-green-400 flex-shrink-0">● OPEN</span>
          )}
        </div>
        <div className="text-[10px] text-text-muted mt-0.5 leading-tight truncate">{description}</div>
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

  const multiEntries: WindowButtonProps[] = [
    { id: 'fuel',        name: 'FUEL',         description: 'Upstream / downstream pressure & actuators', url: '/window/fuel',        accent: '#3498DB' },
    { id: 'lox',         name: 'LOX',          description: 'Oxidizer pressure & actuators',              url: '/window/lox',         accent: '#E74C3C' },
    { id: 'copv',        name: 'COPV / GN2',   description: 'High-pressure bottle & regulator',           url: '/window/copv',        accent: '#27AE60' },
    { id: 'gse',         name: 'GSE',          description: 'Ground support equipment pressures',         url: '/window/gse',         accent: '#F39C12' },
    { id: 'raw',         name: 'Raw ADC',      description: 'All 10 PT & actuator ADC channels',          url: '/window/raw',         accent: '#60A5FA' },
    { id: 'controls',    name: 'Controls',     description: 'State machine & actuator commands',          url: '/window/controls',    accent: '#A78BFA' },
    { id: 'status',      name: 'Status',       description: 'Tabular real-time sensor values',            url: '/window/status',      accent: '#34D399' },
    { id: 'config',      name: 'Config',       description: 'System & board configuration editor',        url: '/window/config',      accent: '#FBBF24' },
    { id: 'controller',  name: 'Controller',   description: 'PWM duty cycle & valve states',              url: '/window/controller',  accent: '#F87171' },
    { id: 'calibration', name: 'Calibration',  description: 'RLS + GLR drift · Bayesian auto-recal',     url: '/window/calibration', accent: '#A3E635' },
  ];

  return (
    <div className="bg-card rounded border border-gray-800 p-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-bold tracking-wider text-text-muted uppercase">View Windows</h2>
          {openCount > 0 && (
            <span className="text-[10px] text-text-muted">{openCount} open</span>
          )}
        </div>
        {openCount > 0 && (
          <button
            onClick={closeAllWindows}
            className="px-2 py-1 bg-red-900/40 border border-red-800 rounded text-[10px] font-semibold text-red-300 hover:bg-red-800/60 transition-colors"
          >
            Close All
          </button>
        )}
      </div>

      {/* All Plots + grid in one row */}
      <div className="grid grid-cols-3 sm:grid-cols-6 lg:grid-cols-11 gap-1.5">
        <WindowButton {...allPlotsEntry} />
        {multiEntries.map((e) => (
          <WindowButton key={e.id} {...e} />
        ))}
      </div>
    </div>
  );
}
