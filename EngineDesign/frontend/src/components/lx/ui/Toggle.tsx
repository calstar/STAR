/**
 * An on/off switch with its label. `role="switch"`, so a screen reader says "on" or "off"; the
 * label is part of the button, so clicking the words flips it too.
 */
export function Toggle({ checked, onChange, label, hideLabel = false, disabled = false, title, className = '' }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  /** The label is still the accessible name, just not drawn (a toolbar). */
  hideLabel?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={hideLabel ? label : undefined} disabled={disabled} title={title}
            onClick={() => onChange(!checked)}
            className={`group inline-flex h-7 cursor-pointer items-center gap-2 rounded-[6px] text-[12px] text-[var(--lx-text-2)] hover:text-[var(--lx-text)] disabled:cursor-not-allowed disabled:opacity-45 ${className}`}>
      <span aria-hidden
            className={`relative inline-block h-4 w-7 shrink-0 rounded-full transition-[color,background-color,border-color] duration-150 ${checked ? 'bg-[var(--lx-accent)]' : 'bg-[var(--lx-text-3)]'}`}>
        <span className={`absolute top-[2px] h-3 w-3 rounded-full bg-[var(--lx-on-accent)] transition-[left] duration-150 ${checked ? 'left-[14px]' : 'left-[2px]'}`} />
      </span>
      {!hideLabel && <span className="whitespace-nowrap">{label}</span>}
    </button>
  );
}
