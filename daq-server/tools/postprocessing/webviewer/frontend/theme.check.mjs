/*
 * Theme guardrails, ported from recovery-calculator/frontend/src/lib/theme.test.ts.
 *
 * Enforces, by parsing src/styles.css directly (so it fails on the real values,
 * not a copy):
 *   1. every text tier clears WCAG AAA (7:1) on every background tier;
 *   2. the three text tiers stay visually distinct;
 *   3. the type scale never drops below 13px and increases monotonically;
 *   4. no font size anywhere resolves below 13px;
 *   5. the chart palette mirror (chartTheme.ts) matches the CSS tokens;
 *   6. every var(--…) referenced is declared, and comments are balanced.
 *
 * Dependency-free: run with `node theme.check.mjs` (also `npm test`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, 'src/styles.css'), 'utf8');
const CHART = readFileSync(join(HERE, 'src/chartTheme.ts'), 'utf8');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

// ── token extraction ─────────────────────────────────────────────────────────
function cssVar(name) {
  const m = CSS.match(new RegExp(`(?<![-\\w])--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`--${name} is not defined in styles.css`);
  return m[1].trim();
}
const colour = (n) => cssVar(`color-${n}`);

// ── WCAG maths ───────────────────────────────────────────────────────────────
function luminance(hex) {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function rem2px(v) {
  const m = v.match(/^([\d.]+)rem$/);
  if (!m) throw new Error(`expected rem, got ${v}`);
  return Number(m[1]) * 16;
}

// ── 1 + 2: contrast + hierarchy ──────────────────────────────────────────────
const TEXT = ['text-primary', 'text-secondary', 'text-muted'];
const BG = ['bg-primary', 'bg-secondary', 'bg-tertiary'];
for (const t of TEXT)
  for (const bg of BG) {
    const r = contrast(colour(t), colour(bg));
    check(r >= 7, `AAA: --color-${t} on --color-${bg} is ${r.toFixed(2)}:1 (< 7)`);
  }
const lum = TEXT.map((t) => luminance(colour(t)));
for (let i = 1; i < lum.length; i++) {
  check(lum[i - 1] > lum[i], `text tiers not monotonic: ${TEXT[i - 1]} <= ${TEXT[i]}`);
  check(
    contrast(colour(TEXT[i - 1]), colour(TEXT[i])) > 1.2,
    `text tiers ${TEXT[i - 1]}/${TEXT[i]} not visually distinct`,
  );
}
check(
  contrast(colour('border'), colour('bg-secondary')) >= 1.4,
  'border not visible enough against bg-secondary',
);

// ── 3: type scale ────────────────────────────────────────────────────────────
const SCALE = ['text-2xs', 'text-xs', 'text-sm', 'text-base', 'text-lg'];
const scalePx = SCALE.map((s) => rem2px(cssVar(s)));
scalePx.forEach((px, i) => check(px >= 13, `--${SCALE[i]} is ${px}px (< 13)`));
for (let i = 1; i < scalePx.length; i++)
  check(scalePx[i] > scalePx[i - 1], `type scale not increasing at --${SCALE[i]}`);

// ── 4: no font size resolves below 13px (css font-size + font shorthand) ──────
const scaleByName = Object.fromEntries(SCALE.map((s, i) => [`--${s}`, scalePx[i]]));
function resolveFontPx(val) {
  const v = val.trim();
  let m;
  if ((m = v.match(/^var\((--text-[\w-]+)\)/))) return scaleByName[m[1]] ?? null;
  if ((m = v.match(/^([\d.]+)px/))) return Number(m[1]);
  if ((m = v.match(/^([\d.]+)rem/))) return Number(m[1]) * 16;
  return null; // keyword / inherit — not a numeric size
}
for (const m of CSS.matchAll(/font-size:\s*([^;]+);/g)) {
  const px = resolveFontPx(m[1]);
  check(px === null || px >= 13, `font-size ${m[1].trim()} resolves below 13px`);
}
for (const m of CSS.matchAll(/(?<![-\w])font:\s*([^;/]+)/g)) {
  const px = resolveFontPx(m[1]);
  check(px === null || px >= 13, `font shorthand size ${m[1].trim()} resolves below 13px`);
}

// ── 5: chart palette mirror matches the CSS tokens ───────────────────────────
function tsConst(name) {
  const m = CHART.match(new RegExp(`${name}\\s*=\\s*'([^']+)'`));
  if (!m) throw new Error(`${name} not found in chartTheme.ts`);
  return m[1];
}
check(
  tsConst('AXIS_STROKE').toLowerCase() === colour('text-muted').toLowerCase(),
  `AXIS_STROKE (${tsConst('AXIS_STROKE')}) != --color-text-muted (${colour('text-muted')})`,
);
check(
  tsConst('GRID_STROKE').toLowerCase() === colour('border').toLowerCase(),
  `GRID_STROKE (${tsConst('GRID_STROKE')}) != --color-border (${colour('border')})`,
);
const axisFontPx = Number(tsConst('AXIS_FONT').match(/^([\d.]+)px/)?.[1] ?? 0);
check(axisFontPx >= 13, `AXIS_FONT is ${axisFontPx}px (< 13)`);

// ── 6: structure — balanced comments + every referenced var declared ─────────
check(
  (CSS.match(/\/\*/g)?.length ?? 0) === (CSS.match(/\*\//g)?.length ?? 0),
  'unbalanced /* */ in styles.css',
);
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const srcFiles = walk(join(HERE, 'src')).filter((p) => /\.(ts|tsx|css)$/.test(p));
const referenced = new Set();
for (const p of srcFiles)
  for (const m of readFileSync(p, 'utf8').matchAll(/var\(\s*(--[\w-]+)\s*\)/g))
    referenced.add(m[1]);
for (const name of referenced)
  check(new RegExp(`(?<![-\\w])${name}:`).test(CSS), `var(${name}) referenced but never declared`);

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`✗ theme check: ${failures.length} violation(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('✓ theme check passed (contrast AAA, type scale ≥13px, palette mirror, vars declared)');
