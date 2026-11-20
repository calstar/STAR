/**
 * Pick a top-bar gauge colour from the palette (lib/gauge-colors): one row per colour family,
 * its shades left to right. A colour already in the config that the palette lacks is kept and
 * shown as "custom" until another is chosen — the picker never rewrites it on its own.
 */
import { useEffect, useRef, useState } from 'react';
import { GAUGE_COLOR_FAMILIES, gaugeColorName } from '@/lib/gauge-colors';

export function GaugeColorPicker({
  value, onChange, disabled = false, className = '',
}: {
  value: string | undefined;
  onChange: (hex: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const current = (value ?? '').trim().toLowerCase();
  const label = current ? (gaugeColorName(current) ?? `custom ${current}`) : 'choose…';

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Gauge colour"
        className="w-full flex items-center gap-2 px-2 py-1.5 bg-background border border-gray-700 rounded text-white text-left disabled:opacity-50"
      >
        <span className="h-4 w-4 shrink-0 rounded-sm border border-white/20" style={{ background: current || 'transparent' }} />
        <span className="truncate text-sm">{label}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Gauge colours"
          className="absolute right-0 z-40 mt-1 p-2 bg-card border border-gray-700 rounded-lg shadow-xl space-y-1">
          {GAUGE_COLOR_FAMILIES.map((f) => (
            <div key={f.name} className="flex items-center gap-1">
              <span className="w-14 text-xs text-text-muted">{f.name}</span>
              {f.shades.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  onClick={() => { onChange(hex); setOpen(false); }}
                  title={gaugeColorName(hex) ?? hex}
                  aria-label={gaugeColorName(hex) ?? hex}
                  aria-pressed={hex === current}
                  className={`h-6 w-6 rounded-sm border ${hex === current ? 'border-white ring-2 ring-white' : 'border-white/10 hover:border-white/60'}`}
                  style={{ background: hex }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
