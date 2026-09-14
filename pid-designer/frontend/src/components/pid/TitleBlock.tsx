import { Panel } from '@xyflow/react';
import { titleRows, type SheetMeta } from './exportImage';

/**
 * The title block, in the corner of the sheet.
 *
 * What every engineering drawing has and this one did not: which drawing
 * this is, which sheet of it, what revision, and when. On screen it is quiet
 * -- a small monospace strip that says where you are -- and the export draws
 * the same rows along the bottom of the page, so the printout and the screen
 * say the same thing.
 */
export function TitleBlock({ meta }: { meta: SheetMeta }) {
  const rows = titleRows(meta);
  return (
    <Panel position="bottom-right" className="pointer-events-none select-none">
      <div className="flex divide-x divide-[var(--color-border)] rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)]/85 font-mono backdrop-blur-sm">
        {rows.map(([label, value], i) => (
          <div key={label} className="px-2.5 py-1">
            <p className="text-[8px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</p>
            <p className={`whitespace-nowrap text-[11px] leading-tight ${i === 0 ? 'font-semibold text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}`}>
              {value}
            </p>
          </div>
        ))}
      </div>
    </Panel>
  );
}
