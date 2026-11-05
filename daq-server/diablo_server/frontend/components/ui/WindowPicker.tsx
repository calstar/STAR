'use client'

/**
 * The plot's time window, as feed-twin's console picks it: four mono labels,
 * the chosen one underlined. Shared so every plot page picks it the same way.
 */
export default function WindowPicker({
  windows,
  value,
  onChange,
}: {
  windows: readonly { label: string; seconds: number }[];
  value: number;
  onChange: (seconds: number) => void;
}) {
  return (
    <div className="flex items-baseline gap-1">
      {windows.map((w) => {
        const active = value === w.seconds;
        return (
          <button
            key={w.label}
            type="button"
            onClick={() => onChange(w.seconds)}
            className={`border-b px-3 pb-1.5 font-mono text-[13px] transition-colors ${
              active ? 'border-ink text-ink' : 'border-transparent text-ink-3 hover:text-ink-2'
            }`}
          >
            {w.label}
          </button>
        );
      })}
    </div>
  );
}
