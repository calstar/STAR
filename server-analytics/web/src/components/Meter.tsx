/** A labelled usage bar. Amber past 75%, red past 90%, with the number always shown. */
export function Meter({ label, value, detail }: { label: string; value: number | null; detail: string }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  const bar = v >= 90 ? "bg-red-500" : v >= 75 ? "bg-amber-500" : "bg-neutral-800 dark:bg-neutral-200";
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-neutral-500 dark:text-neutral-400">{detail}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}
