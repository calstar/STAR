import { COMPONENT_DEFS, type ComponentType } from './types';

const GROUP_ORDER = ['Sensors', 'Valves', 'Flow Control', 'Hardware'] as const;

function PaletteSymbol({ type }: { type: ComponentType }) {
  switch (type) {
    case 'RTD': case 'PT': case 'PG': case 'LC': case 'TC':
      return (
        <svg width="28" height="28" viewBox="0 0 28 28">
          <circle cx="14" cy="14" r="11" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.2" />
          <text x="14" y="18" textAnchor="middle" fontSize="6" fill="#e2e8f0" fontFamily="monospace">{type}</text>
        </svg>
      );
    case 'MAN': case 'ROT': case 'SOL':
      return (
        <svg width="32" height="28" viewBox="0 0 32 28">
          <polygon points="2,4 30,22 30,4 2,22" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.2" />
          {type !== 'MAN' && (
            <>
              <rect x="11" y="0" width="10" height="6" rx="1" fill="#1e293b" stroke="#94a3b8" strokeWidth="1" />
              <text x="16" y="5.5" textAnchor="middle" fontSize="4" fill="#cbd5e1" fontFamily="monospace">
                {type === 'SOL' ? 'S' : 'P'}
              </text>
            </>
          )}
        </svg>
      );
    case 'CV':
      return (
        <svg width="28" height="24" viewBox="0 0 28 24">
          <line x1="14" y1="2" x2="14" y2="22" stroke="#94a3b8" strokeWidth="1.2" />
          <polygon points="14,12 26,4 26,20" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.2" />
          <line x1="4" y1="2"  x2="14" y2="12" stroke="#94a3b8" strokeWidth="1.2" />
          <line x1="4" y1="22" x2="14" y2="12" stroke="#94a3b8" strokeWidth="1.2" />
        </svg>
      );
    case 'PR':
      return (
        <svg width="28" height="28" viewBox="0 0 28 28">
          <rect x="4" y="4" width="20" height="20" rx="2" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.2" />
          <line x1="8" y1="20" x2="20" y2="8" stroke="#94a3b8" strokeWidth="1.2" />
          <polygon points="20,8 16,10 18,12" fill="#94a3b8" />
        </svg>
      );
    case 'RV':
      return (
        <svg width="32" height="26" viewBox="0 0 32 26">
          <polygon points="2,6 30,18 30,6 2,18" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.2" />
          <polyline points="10,6 12,2 14,6 16,2 18,6 20,2" fill="none" stroke="#94a3b8" strokeWidth="1.2" />
        </svg>
      );
    case 'QD':
      return (
        <svg width="28" height="28" viewBox="0 0 28 28">
          <circle cx="14" cy="14" r="11" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.2" />
          <line x1="7"  y1="7"  x2="21" y2="21" stroke="#94a3b8" strokeWidth="1.5" />
          <line x1="21" y1="7"  x2="7"  y2="21" stroke="#94a3b8" strokeWidth="1.5" />
        </svg>
      );
    case 'TANK':
      return (
        <svg width="32" height="44" viewBox="0 0 32 44">
          <ellipse cx="16" cy="8"  rx="13" ry="5" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.2" />
          <rect x="3" y="8" width="26" height="28" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.2" />
          <ellipse cx="16" cy="36" rx="13" ry="5" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.2" />
        </svg>
      );
    case 'INJECTOR':
      return (
        <svg width="32" height="44" viewBox="0 0 32 44">
          <rect x="6" y="2" width="20" height="10" rx="1" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.2" />
          <polygon points="6,12 26,12 20,40 12,40" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.2" />
        </svg>
      );
    case 'JUNCTION':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="6" fill="#94a3b8" stroke="#94a3b8" strokeWidth="1" />
        </svg>
      );
    case 'TEXT':
      return (
        <svg width="32" height="24" viewBox="0 0 32 24">
          <rect x="1" y="1" width="30" height="22" rx="3" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="3 2" />
          <text x="16" y="16" textAnchor="middle" fontSize="11" fill="#e2e8f0" fontFamily="serif" fontStyle="italic">T</text>
        </svg>
      );
    default:
      return null;
  }
}

export function ComponentPalette() {
  const grouped = GROUP_ORDER.map(group => ({
    group,
    items: COMPONENT_DEFS.filter(d => d.group === group),
  }));

  const onDragStart = (e: React.DragEvent, type: ComponentType) => {
    e.dataTransfer.setData('application/pid-type', type);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <aside className="w-52 shrink-0 bg-[#0f172a] border-r border-[#1e293b] overflow-y-auto flex flex-col">
      <div className="p-3 border-b border-[#1e293b]">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Components</h2>
      </div>
      {grouped.map(({ group, items }) => (
        <div key={group} className="px-2 py-2">
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1 px-1">{group}</p>
          {items.map(def => (
            <div
              key={def.type}
              draggable
              onDragStart={e => onDragStart(e, def.type)}
              title={def.fullName}
              className="flex items-center gap-2 px-2 py-1.5 rounded cursor-grab active:cursor-grabbing hover:bg-[#1e293b] transition-colors"
            >
              <div className="flex items-center justify-center w-9 h-9 shrink-0">
                <PaletteSymbol type={def.type} />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-300 truncate">{def.label}</p>
                <p className="text-[10px] text-slate-500 truncate leading-tight">{def.fullName}</p>
              </div>
            </div>
          ))}
        </div>
      ))}
    </aside>
  );
}
