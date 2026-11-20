/**
 * The colours a top-bar gauge can take: a few families, several shades each, lightest first.
 * Shades exist so one system's gauges can share a family — every fuel gauge a red, every LOX
 * gauge a blue — and still be told apart. All are legible on the dark top bar.
 */
export interface GaugeColorFamily { name: string; shades: string[] }

export const GAUGE_COLOR_FAMILIES: GaugeColorFamily[] = [
  { name: 'Red',    shades: ['#fca5a5', '#f87171', '#ef4444', '#dc2626', '#b91c1c'] },
  { name: 'Orange', shades: ['#fdba74', '#fb923c', '#f97316', '#ea580c', '#c2410c'] },
  { name: 'Yellow', shades: ['#fde047', '#facc15', '#eab308', '#ca8a04', '#a16207'] },
  { name: 'Green',  shades: ['#86efac', '#4ade80', '#22c55e', '#16a34a', '#15803d'] },
  { name: 'Cyan',   shades: ['#67e8f9', '#22d3ee', '#06b6d4', '#0891b2', '#0e7490'] },
  { name: 'Blue',   shades: ['#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8'] },
  { name: 'Purple', shades: ['#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9'] },
  { name: 'Pink',   shades: ['#f9a8d4', '#f472b6', '#ec4899', '#db2777', '#be185d'] },
  { name: 'Gray',   shades: ['#e5e7eb', '#d1d5db', '#9ca3af', '#6b7280', '#4b5563'] },
];

const SHADE_NAMES = ['light', 'soft', 'base', 'deep', 'dark'];

/** "Red · deep" for a palette colour; null for one the palette does not have. */
export function gaugeColorName(hex: string | undefined | null): string | null {
  const h = String(hex ?? '').trim().toLowerCase();
  for (const f of GAUGE_COLOR_FAMILIES) {
    const i = f.shades.indexOf(h);
    if (i >= 0) return `${f.name} · ${SHADE_NAMES[i] ?? i + 1}`;
  }
  return null;
}
