import type { TooltipProps } from 'recharts';

type Props = TooltipProps<number, string>;

/** Tooltip anchored beside the cursor so the chart stays visible. */
export function SideTooltip({ active, payload, label, coordinate, viewBox }: Props) {
  if (!active || !payload?.length || !coordinate) return null;

  const vbW = viewBox && 'width' in viewBox ? Number(viewBox.width) : 320;
  const coordX = coordinate.x ?? 0;
  const coordY = coordinate.y ?? 0;
  const placeRight = coordX < vbW * 0.5;
  const boxW = 168;
  const left = placeRight ? coordX + 14 : coordX - boxW - 14;
  const top = Math.max(4, coordY - 36);

  return (
    <div
      className="pointer-events-none z-50 rounded-lg border border-[#334155] bg-[#1e293b] px-3 py-2 text-xs shadow-lg"
      style={{ position: 'absolute', left, top, width: boxW }}
    >
      {label != null && (
        <p className="font-semibold text-[var(--color-text-primary)] mb-1">{label}</p>
      )}
      <ul className="space-y-0.5 text-[var(--color-text-secondary)]">
        {payload.map((entry) => (
          <li key={entry.name} className="flex justify-between gap-2">
            <span style={{ color: entry.color ?? '#94a3b8' }}>{entry.name}</span>
            <span className="font-mono text-[var(--color-text-primary)]">
              {typeof entry.value === 'number' ? entry.value.toFixed(3) : entry.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
