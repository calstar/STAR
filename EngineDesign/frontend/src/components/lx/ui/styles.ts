/** Button looks, shared by Button, Menu's trigger, and anything that must look like a button. */
export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'bare';
export type ButtonSize = 'sm' | 'md';

const BASE =
  'inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] font-medium ' +
  'transition-[color,background-color,border-color] duration-100 disabled:cursor-not-allowed disabled:opacity-45';

const VARIANT: Record<ButtonVariant, string> = {
  // One filled accent per view: Run, Calibrate, Use these settings.
  primary: 'bg-[var(--lx-accent)] text-[var(--lx-on-accent)] hover:brightness-110 active:brightness-95 disabled:hover:brightness-100',
  ghost: 'border border-[var(--lx-line-strong)] text-[var(--lx-text)] hover:bg-[var(--lx-surface-2)] disabled:hover:bg-transparent',
  danger: 'border border-[var(--lx-bad-line)] text-[var(--lx-bad)] hover:bg-[var(--lx-bad-soft)] disabled:hover:bg-transparent',
  // Toolbar icons and inline actions: no border until hovered.
  bare: 'text-[var(--lx-text-2)] hover:bg-[var(--lx-surface-2)] hover:text-[var(--lx-text)] disabled:hover:bg-transparent',
};

const SIZE: Record<ButtonSize, { box: string; icon: string }> = {
  md: { box: 'h-7 px-3 text-[13px]', icon: 'h-7 w-7 text-[13px]' },
  sm: { box: 'h-6 px-2 text-[12px]', icon: 'h-6 w-6 text-[12px]' },
};

/** The class string, for a link or label that must look like a button. */
export function buttonClass(variant: ButtonVariant = 'ghost', size: ButtonSize = 'md', iconOnly = false): string {
  return `${BASE} ${VARIANT[variant]} ${iconOnly ? SIZE[size].icon : SIZE[size].box}`;
}
