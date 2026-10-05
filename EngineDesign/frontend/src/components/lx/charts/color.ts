/**
 * Colours for a canvas. A chart's colours are CSS (a token like `--lx-lox`, `var(--lx-lox)`, or a
 * plain value); canvas needs a resolved string, read at draw time so a theme switch repaints.
 */

/** A colour as given to a chart, normalised to something CSS accepts: `--lx-lox` becomes `var(--lx-lox)`. */
export function cssColor(c: string): string {
  const s = c.trim();
  return s.startsWith('--') ? `var(${s})` : s;
}

/** The custom property a colour names, if it is one (`--x`, `var(--x)`, `var(--x, fallback)`). */
export function parseCssVar(c: string): { name: string; fallback?: string } | null {
  const s = c.trim();
  if (/^--[\w-]+$/.test(s)) return { name: s };
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(s);
  if (!m) return null;
  return m[2] !== undefined ? { name: m[1], fallback: m[2].trim() } : { name: m[1] };
}

/**
 * Resolves colours against an element's computed style, through a hidden probe so anything CSS
 * can say (a token, `color-mix`, a name) comes back as an `rgb()` the canvas takes. Cached until
 * `reset()` (a theme change).
 */
export class ColorResolver {
  private cache = new Map<string, string>();
  private probe: HTMLSpanElement | null = null;
  private host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  reset(): void {
    this.cache.clear();
  }

  get(c: string): string {
    const hit = this.cache.get(c);
    if (hit !== undefined) return hit;
    const v = this.resolve(c);
    this.cache.set(c, v);
    return v;
  }

  private resolve(c: string): string {
    const css = cssColor(c);
    if (!parseCssVar(c) && !/var\(|color-mix|currentcolor/i.test(css)) return css;
    if (typeof getComputedStyle !== 'function') return '#888';
    if (!this.probe) {
      this.probe = document.createElement('span');
      this.probe.setAttribute('aria-hidden', 'true');
      this.probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
    }
    if (this.probe.parentNode !== this.host) this.host.appendChild(this.probe);
    this.probe.style.color = '';
    this.probe.style.color = css;
    const out = getComputedStyle(this.probe).color;
    return out || '#888';
  }

  destroy(): void {
    this.probe?.remove();
    this.probe = null;
    this.cache.clear();
  }
}
