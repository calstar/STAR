import { useId, useState, type ReactNode } from 'react';
import type { GlossaryKey } from '../glossary';
import type { Scale } from '../units';
import { editText, fieldError, parseNumber, sameAtDigits } from './fieldParse';
import { Term } from './Term';

/**
 * A number field: label left, the unit inside the input's right edge, the value in mono.
 *
 * Commits on blur or Enter, never per keystroke: typing "4." or clearing the field on the way to
 * another number never becomes a value. Escape puts the value back. A value that does not parse or
 * is out of range stays in the box with the reason under it, in --lx-bad, and is not committed.
 *
 * With `scale` (from `useUnits().scale(...)`), `value`, `defaultValue`, `min` and `max` are in the
 * model's units (psia, N, kg, m) and the field shows and reads the display unit. Without it, they
 * are taken as they are, in `unit`.
 *
 * A measured value carries a `measured ±x` chip under its label; its title says where it came from.
 *
 * `defaultValue` is the design's own value: when the field differs from it (at the field's digits)
 * an accent dot shows, which becomes ↺ on hover or focus and puts the design value back.
 */
export function Field({
  label, value, onCommit, scale, unit, digits, defaultValue, min, max, validate, allowEmpty = false, error,
  measured, disabled = false, readOnly = false, termKey, id, inputWidth = 112, placeholder, title, stacked = false, aside,
}: {
  label: string;
  value: number | null | undefined;
  onCommit: (v: number | null) => void;
  scale?: Scale;
  unit?: string;
  digits?: number;
  defaultValue?: number | null;
  min?: number;
  max?: number;
  /** The caller's own rule, in display units; return the message, or null. */
  validate?: (v: number | null) => string | null;
  allowEmpty?: boolean;
  /** An error from elsewhere (the server refused it). */
  error?: string | null;
  /** A measured value: "±3 psi" and where it came from. */
  measured?: { pm: string; title?: string };
  disabled?: boolean;
  readOnly?: boolean;
  termKey?: GlossaryKey;
  id?: string;
  inputWidth?: number | string;
  placeholder?: string;
  title?: string;
  /** Label above the input instead of beside it (a narrow rail). */
  stacked?: boolean;
  /** Something small beside the label (an instrument tag). */
  aside?: ReactNode;
}) {
  const autoId = useId();
  const inputId = id ?? `${autoId}-in`;
  const errId = `${inputId}-err`;
  const noteId = `${inputId}-note`;
  const u = scale?.unit ?? unit ?? '';
  const d = scale?.digits ?? digits ?? 0;
  const toD = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : scale ? scale.to(x) : x);
  const fromD = (x: number | null) => (x === null ? null : scale ? scale.from(x) : x);

  const shown = toD(value);
  const def = defaultValue === undefined ? undefined : toD(defaultValue);
  const changed = def !== undefined && !sameAtDigits(shown, def, d);

  const [draft, setDraft] = useState<string | null>(null);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const message = localErr ?? error ?? null;
  const locked = disabled || readOnly;

  const commit = () => {
    if (draft === null) return;
    const p = parseNumber(draft);
    const err = fieldError(p, {
      min: min === undefined ? undefined : toD(min) ?? undefined,
      max: max === undefined ? undefined : toD(max) ?? undefined,
      allowEmpty, unit: u, digits: d, validate,
    });
    if (err) { setLocalErr(err); return; }
    setLocalErr(null);
    setDraft(null);
    const v = p.kind === 'number' ? p.value : null;
    // Retyping what is shown is not an edit: it must not replace the stored value with its rounding.
    if (sameAtDigits(v, shown, d)) return;
    onCommit(fromD(v));
  };

  const reset = () => {
    setDraft(null);
    setLocalErr(null);
    onCommit(defaultValue ?? null);
  };

  const defText = def === undefined ? '' : def === null ? 'blank' : `${editText(def, d)}${u ? ` ${u}` : ''}`;
  // The unit sits 8 px in from the right; the number stops 6 px short of it (11 px Inter: wide m, ², K).
  const unitPad = u ? 14 + u.length * 6.6 : 8;

  return (
    <div className={`group min-w-0 ${stacked ? 'space-y-1' : ''}`} title={title}>
      <div className={stacked ? 'space-y-1' : 'flex min-h-7 items-center gap-2'}>
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {/* The changed-from-design dot; on hover or focus it is the reset. */}
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {changed && !locked ? (
              <button type="button" onClick={reset} aria-label={`Reset ${label} to the design value, ${defText}`} title={`Design value ${defText}`}
                      className="flex h-4 w-4 cursor-pointer items-center justify-center rounded-[4px] text-[11px] leading-none text-[var(--lx-accent)] hover:bg-[var(--lx-surface-2)]">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--lx-accent)] group-hover:hidden group-focus-within:hidden" />
                <span aria-hidden className="hidden group-hover:inline group-focus-within:inline">↺</span>
              </button>
            ) : changed ? (
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--lx-accent)]" />
            ) : null}
          </span>
          <label htmlFor={inputId} className="min-w-0 truncate text-[12px] text-[var(--lx-text-2)]">
            {termKey ? <Term k={termKey}>{label}</Term> : label}
          </label>
          {aside}
        </div>
        <div className="relative shrink-0" style={{ width: stacked ? '100%' : inputWidth }}>
          <input id={inputId} type="text" inputMode="decimal" autoComplete="off" spellCheck={false}
                 disabled={disabled} readOnly={readOnly} placeholder={placeholder}
                 aria-invalid={message ? true : undefined}
                 aria-describedby={[message ? errId : '', changed ? noteId : ''].filter(Boolean).join(' ') || undefined}
                 value={draft ?? editText(shown, d)}
                 onChange={(e) => { setDraft(e.target.value); if (localErr) setLocalErr(null); }}
                 onBlur={commit}
                 onKeyDown={(e) => {
                   if (e.key === 'Enter') { e.preventDefault(); commit(); }
                   else if (e.key === 'Escape' && draft !== null) { e.preventDefault(); e.stopPropagation(); setDraft(null); setLocalErr(null); }
                 }}
                 style={{ paddingRight: unitPad }}
                 className={`lx-num h-7 w-full rounded-[6px] border bg-[var(--lx-bg)] pl-2 text-right text-[13px] text-[var(--lx-text)] transition-[color,background-color,border-color] duration-100 placeholder:text-[var(--lx-text-3)] hover:border-[var(--lx-text-3)] disabled:cursor-not-allowed disabled:opacity-45 read-only:cursor-default read-only:text-[var(--lx-text-2)] read-only:hover:border-[var(--lx-line-strong)] ${
                   message ? 'border-[var(--lx-bad)]' : 'border-[var(--lx-line-strong)]'}`} />
          {u && <span aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-[var(--lx-text-3)]">{u}</span>}
        </div>
      </div>
      {measured && (
        <div className={`mt-0.5 ${stacked ? '' : 'pl-5'}`}>
          <span title={measured.title}
                className="lx-num inline-flex h-[18px] items-center rounded-[4px] bg-[var(--lx-surface-2)] px-1.5 text-[11px] text-[var(--lx-text-2)]">
            measured {measured.pm}
          </span>
        </div>
      )}
      {changed && <span id={noteId} hidden>Changed from the design value, {defText}.</span>}
      {message && <div id={errId} role="alert" className={`mt-1 text-[11px] leading-snug text-[var(--lx-bad)] ${stacked ? '' : 'pl-5'}`}>{message}</div>}
    </div>
  );
}
