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
        const result = openWindow(id, name, url);
        if (!result) {
          console.warn(`[WindowLauncher] Failed to open ${name} - check popup blocker`);
        }
      }}
      className={`
        relative overflow-hidden bg-white/[0.02] backdrop-blur-md rounded-xl border transition-all duration-300 text-left group
        hover:bg-white/[0.06] hover:shadow-xl hover:-translate-y-0.5
        ${isOpen ? 'border-emerald-500/40 shadow-[0_0_15px_rgba(16,185,129,0.15)] ring-1 ring-inset ring-emerald-500/20' : 'border-white/5'}
      `}
    >
      <div className="absolute left-0 top-0 bottom-0 w-1.5 rounded-l-lg" style={{ backgroundColor: accent }} />
      <div className="px-4 py-3 pl-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-bold tracking-wide text-gray-200 group-hover:text-white transition-colors">{name}</span>
          {isOpen && (
            <span className="text-xs font-black font-mono text-emerald-400 flex-shrink-0 drop-shadow-[0_0_5px_rgba(16,185,129,0.5)]">● OPEN</span>
          )}
        </div>
        <div className="text-[11px] font-semibold text-gray-400 mt-1 leading-relaxed line-clamp-2 group-hover:text-gray-300 transition-colors">{description}</div>
      </div>
    </button>
  );
}

export default function WindowLauncher() {
  const { closeAllWindows, windows } = useWindowManager();
  const openCount = windows.filter((w) => w.window && !w.window.closed).length;

  const unifiedEntry: WindowButtonProps = {
    id: 'unified', name: 'Single Pane ★★',
    description: 'State machine · Pressure graphs · Actuators · Controller all in one window',
    url: '/window/unified', accent: '#EC4899',
  };

  const multiEntries: WindowButtonProps[] = [
    { id: 'ipad', name: 'iPad View', description: 'Scrollable layout for iPad Air', url: '/window/ipad', accent: '#8B5CF6' },
    { id: 'livestream', name: 'Livestream Stats', description: 'Broadcast pane with state, mission timer, and selectable PT dials', url: '/window/livestream', accent: '#38BDF8' },
    { id: 'fuel', name: 'FUEL', description: 'Upstream / downstream pressure & actuators', url: '/window/fuel', accent: '#3498DB' },
    { id: 'lox', name: 'LOX', description: 'Oxidizer pressure & actuators', url: '/window/lox', accent: '#E74C3C' },
    { id: 'chamber', name: 'Chamber', description: 'PT / TC / LC Measurements in one pane', url: '/window/chamber', accent: '#F97316' },
    { id: 'copv', name: 'COPV / GN2', description: 'High-pressure bottle & regulator', url: '/window/copv', accent: '#27AE60' },
    { id: 'gse', name: 'GSE', description: 'Ground support equipment pressures', url: '/window/gse', accent: '#F39C12' },
    { id: 'status', name: 'Status', description: 'Tabular real-time sensor values', url: '/window/status', accent: '#34D399' },
    { id: 'boards', name: 'Boards / Heartbeats', description: 'Discovered boards and heartbeat status', url: '/window/boards', accent: '#10B981' },
    { id: 'self-tests', name: 'Board Self Tests', description: 'Detailed breakdowns for diagnostics passed/failed per hotfire frame', url: '/window/self-tests', accent: '#A855F7' },
    { id: 'flash', name: 'Ethernet OTA Flash', description: 'Flash firmware to boards over Ethernet', url: '/window/flash', accent: '#06B6D4' },
    { id: 'config', name: 'Config', description: 'System & board configuration editor', url: '/window/config', accent: '#FBBF24' },
    { id: 'controller', name: 'Controller', description: 'PWM duty cycle & valve states', url: '/window/controller', accent: '#F87171' },
    { id: 'calibration', name: 'Calibration', description: 'RLS + GLR drift · Bayesian auto-recal', url: '/window/calibration', accent: '#A3E635' },
    { id: 'lcs-tcs-rtd', name: 'LCS / TCS / RTD', description: 'Thermocouples, RTDs, load cell — voltage and temperature', url: '/window/lcs-tcs-rtd', accent: '#F59E0B' },
    { id: 'sensor-info', name: 'Sensor Info', description: 'ADC code · converted value · data rate per channel', url: '/window/sensor-info', accent: '#22D3EE' },
    { id: 'solenoid-char', name: 'Solenoid Characterization', description: 'PWM duty cycle & frequency for solenoid performance', url: '/window/solenoid-char', accent: '#F59E0B' },
    { id: 'encoders', name: 'Encoders', description: 'Encoder board angles and connection status', url: '/window/encoders', accent: '#7C3AED' },
    { id: 'feed-char', name: 'Feed System Char', description: 'CdA, MDOT, Reynolds Number characterization', url: '/window/feed-char', accent: '#3B82F6' },
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
