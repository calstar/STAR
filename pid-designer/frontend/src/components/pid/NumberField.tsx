import { useState } from 'react';

/**
 * A number field you can actually type a number into.
 *
 * A field whose `value` is re-derived from the model on every keystroke cannot
 * be typed into, and the failure is specific to small numbers: to write 0.48
 * you must first write "0", then "0.", neither of which parses to anything the
 * model will accept, so each one is thrown away and the field snaps back. The
 * first keystroke that does parse is then reformatted -- "4" becomes "4.00" --
 * and the rest of the number has nowhere to go. The bore field behaved exactly
 * that way, and the only bores reachable were the ones that happened to be
 * whole.
 *
 * So the text being typed is held here, separately from the model:
 *
 * - while the field has focus, what you typed is what is shown;
 * - every keystroke that parses to an acceptable number is committed, so the
 *   drawing follows along as you type rather than waiting for a blur;
 * - on blur the draft is dropped and the model's own formatting comes back,
 *   which is also how a unit change or a size picked off the chart reaches the
 *   field.
 *
 * `accept` decides what counts. It is not `> 0` by default because "0" is a
 * legitimate thing to have typed *so far*, and rejecting it is the whole bug.
 */
export function NumberField({
  value,
  onCommit,
  accept = (n) => n > 0,
  className,
  placeholder,
  readOnly,
  title,
}: {
  /** The model's number, formatted. Shown whenever the field is not being typed into. */
  value: string;
  /** Called for each keystroke that parses and passes `accept`. */
  onCommit: (n: number) => void;
  accept?: (n: number) => boolean;
  className?: string;
  placeholder?: string;
  readOnly?: boolean;
  title?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <input
      inputMode="decimal"
      readOnly={readOnly}
      title={title}
      className={className}
      placeholder={placeholder}
      value={draft ?? value}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        const n = Number(text);
        if (text.trim() !== '' && Number.isFinite(n) && accept(n)) onCommit(n);
      }}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      onBlur={() => setDraft(null)}
    />
  );
}
