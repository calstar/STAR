import { COMPONENT_DEFS, type ComponentType } from './types';

const GROUP_ORDER = ['Sensors', 'Valves', 'Flow Control', 'Hardware', 'Supplies', 'Annotation'] as const;

function PaletteSymbol({ type }: { type: ComponentType }) {
  switch (type) {
    // PT/PG are plumbed (a port on the canvas symbol); RTD/TC/LC clip to
    // what they measure and get no port at all -- see SensorNode.tsx. Dashed
    // here previews that difference before the part is even dropped, rather
    // than leaving it to be discovered on canvas.
    case 'PT': case 'PG':
      return (
        <svg width="28" height="28" viewBox="0 0 28 28">
          <circle cx="14" cy="14" r="11" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
          <text x="14" y="18" textAnchor="middle" fontSize="6" fill="var(--color-text-primary)" fontFamily="monospace">{type}</text>
        </svg>
      );
    case 'RTD': case 'LC': case 'TC':
      return (
        <svg width="28" height="28" viewBox="0 0 28 28">
          <circle cx="14" cy="14" r="11" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" strokeDasharray="2.5 2" />
          <text x="14" y="18" textAnchor="middle" fontSize="6" fill="var(--color-text-primary)" fontFamily="monospace">{type}</text>
        </svg>
      );
    case 'MAN': case 'ROT': case 'SOL':
      return (
        <svg width="32" height="28" viewBox="0 0 32 28">
          <polygon points="2,4 30,22 30,4 2,22" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
          {type !== 'MAN' && (
            <>
              <rect x="11" y="0" width="10" height="6" rx="1" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1" />
              <text x="16" y="5.5" textAnchor="middle" fontSize="4" fill="var(--color-text-secondary)" fontFamily="monospace">
                {type === 'SOL' ? 'S' : 'P'}
              </text>
            </>
          )}
        </svg>
      );
    case 'CV':
      return (
        <svg width="28" height="24" viewBox="0 0 28 24">
          <line x1="14" y1="2" x2="14" y2="22" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
          <polygon points="14,12 26,4 26,20" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
          <line x1="4" y1="2"  x2="14" y2="12" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
          <line x1="4" y1="22" x2="14" y2="12" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
        </svg>
      );
    case 'PR':
      return (
        <svg width="28" height="28" viewBox="0 0 28 28">
          <rect x="4" y="4" width="20" height="20" rx="2" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
          <line x1="8" y1="20" x2="20" y2="8" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
          <polygon points="20,8 16,10 18,12" fill="var(--color-text-secondary)" />
        </svg>
      );
    case 'RV':
      return (
        <svg width="32" height="26" viewBox="0 0 32 26">
          <polygon points="2,6 30,18 30,6 2,18" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
          <polyline points="10,6 12,2 14,6 16,2 18,6 20,2" fill="none" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
        </svg>
      );
    case 'QD':
      return (
        <svg width="28" height="28" viewBox="0 0 28 28">
          <circle cx="14" cy="14" r="11" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
          <line x1="7"  y1="7"  x2="21" y2="21" stroke="var(--color-text-secondary)" strokeWidth="1.5" />
          <line x1="21" y1="7"  x2="7"  y2="21" stroke="var(--color-text-secondary)" strokeWidth="1.5" />
        </svg>
      );
    case 'TANK':
      return (
        <svg width="32" height="44" viewBox="0 0 32 44">
          <ellipse cx="16" cy="8"  rx="13" ry="5" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
          <rect x="3" y="8" width="26" height="28" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
          <ellipse cx="16" cy="36" rx="13" ry="5" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
        </svg>
      );
    case 'ENGINE':
      return (
        <svg width="30" height="44" viewBox="0 0 30 44">
          <rect x="5" y="2" width="20" height="9" rx="1" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
          <line x1="5" y1="11" x2="25" y2="11" stroke="var(--color-text-secondary)" strokeWidth="1" />
          <path d="M7,11 L7,22 Q7,27 13,30 L17,30 Q23,27 23,22 L23,11" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
          <path d="M13,30 Q10,36 7,42 L23,42 Q20,36 17,30 Z" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
        </svg>
      );
    case 'MANIFOLD':
      return (
        <svg width="34" height="20" viewBox="0 0 34 20">
          <rect x="1" y="4" width="32" height="12" rx="2" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
          <line x1="3" y1="10" x2="31" y2="10" stroke="var(--color-text-secondary)" strokeWidth="1" strokeDasharray="2 2" />
          {[9, 17, 25].map(x => <line key={x} x1={x} y1="16" x2={x} y2="19" stroke="var(--color-text-secondary)" strokeWidth="1.2" />)}
        </svg>
      );
    case 'JUNCTION':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="6" fill="var(--color-text-secondary)" stroke="var(--color-text-secondary)" strokeWidth="1" />
        </svg>
      );
    case 'KBOTTLE':
      return (
        <svg width="22" height="44" viewBox="0 0 22 44">
          <rect x="8" y="1" width="6" height="5" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.1" />
          <path d="M3,14 Q3,7 11,6 Q19,7 19,14 L19,41 Q19,43 17,43 L5,43 Q3,43 3,41 Z"
            fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
        </svg>
      );
    case 'DEWAR':
      return (
        <svg width="30" height="40" viewBox="0 0 30 40">
          <rect x="12" y="1" width="6" height="4" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1" />
          <rect x="2" y="5" width="26" height="33" rx="7" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" />
          <rect x="6" y="9" width="18" height="25" rx="5" fill="none" stroke="var(--color-text-secondary)" strokeWidth="0.9" strokeDasharray="2 2" />
        </svg>
      );
    case 'REGION':
      return (
        <svg width="34" height="26" viewBox="0 0 34 26">
          <rect x="2" y="5" width="30" height="19" rx="3" fill="var(--color-text-muted)" fillOpacity={0.08} stroke="var(--color-text-muted)" strokeWidth="1.2" strokeDasharray="4 2.5" />
          <rect x="5" y="1" width="16" height="8" rx="1" fill="var(--color-bg-secondary)" />
          <text x="7" y="7.5" fontSize="6" fill="var(--color-text-secondary)" fontFamily="monospace">GSE</text>
        </svg>
      );
    case 'TEXT':
      return (
        <svg width="32" height="24" viewBox="0 0 32 24">
          <rect x="1" y="1" width="30" height="22" rx="3" fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth="1.2" strokeDasharray="3 2" />
          <text x="16" y="16" textAnchor="middle" fontSize="11" fill="var(--color-text-primary)" fontFamily="serif" fontStyle="italic">T</text>
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

  // The *entry* id travels, not the component type. "PT (high press)" and
  // "PT (low press)" are one component with different presets, and the drop
  // handler needs to know which of the two was picked.
  const onDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData('application/pid-entry', id);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    // No border, no distinct background from the canvas beside it -- both
    // sit on the identical --color-bg-primary, so the seam between "list of
    // parts" and "drawing" nearly disappears. Differentiation between parts
    // and groups is entirely typographic and spatial from here down: weight,
    // size, whitespace, and one hairline rule per row -- never color. See
    // .impeccable/surfaces/pid-designer-frontend.md.
    <aside className="w-56 shrink-0 bg-[var(--color-bg-primary)] overflow-y-auto flex flex-col">
      <div className="px-3 pt-3 pb-2">
        <h2 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
          Components
        </h2>
      </div>
      {grouped.map(({ group, items }, i) => (
        <div key={group} className={i > 0 ? 'mt-4' : ''}>
          <p className="px-3 pb-1 text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-widest">
            {group}
          </p>
          <div className="border-t border-[var(--color-border)]">
            {items.map(def => (
              // A spec-sheet row, not a card: no box, no per-item background
              // by default -- the call number is the loudest thing here on
              // purpose, the icon that used to dominate the row is now a
              // quiet corner mark, and the only structure is one hairline
              // beneath each row.
              <div
                key={def.id}
                draggable
                onDragStart={e => onDragStart(e, def.id)}
                title={def.fullName}
                className="group flex items-center gap-2.5 border-b border-[var(--color-border)] px-3 py-2 cursor-grab active:cursor-grabbing hover:bg-[var(--color-bg-tertiary)] transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[13px] font-bold leading-tight tracking-tight text-[var(--color-text-primary)] truncate">
                    {def.label}
                  </p>
                  <p className="font-mono text-[9px] uppercase tracking-wide text-[var(--color-text-muted)] truncate leading-tight mt-0.5">
                    {def.fullName}
                  </p>
                </div>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center">
                  <PaletteSymbol type={def.type} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </aside>
  );
}
