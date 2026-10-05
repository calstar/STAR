import { useState } from 'react';

/** The compact number cell the Layer X forms use. */
const cellClass = 'w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-1 text-[12px] tabular-nums text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]';

/**
 * A number field that holds what is typed until it is left, then commits it: typing "4." or
 * clearing the field on the way to another number never becomes a value mid-edit.
 */
export function DraftNumber({ value, onCommit, disabled, ariaLabel, placeholder }: {
  value: number | string; onCommit: (text: string) => void; disabled?: boolean; ariaLabel: string; placeholder?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input className={cellClass} inputMode="decimal" aria-label={ariaLabel} disabled={disabled} placeholder={placeholder}
           value={draft ?? String(value)}
           onChange={(e) => setDraft(e.target.value.replace(/[^0-9.eE-]/g, ''))}
           onBlur={() => { if (draft !== null) { onCommit(draft); setDraft(null); } }}
           onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
}
