// Instant fuzzy search over every part field, shared by the hub and the Onshape panel.
//
// Every word of the query must match some field. A word matches a field by (best first):
// whole word > word prefix > substring > same characters ignoring punctuation
// ("ss4006" finds "SS-400-6") > one or two typos ("vlave") > letters in order ("tbun").
// Name and part number weigh most, then vendor/category/tags, then everything else.
//
// Sizes and part numbers are matched exactly, never "typo-corrected": 5000 must not
// find 3000, 1/4 must not find 11/4, SS-400-6 must not find SS-400-9. Fractions and
// decimals are interchangeable (0.25 finds 1/4), inch marks are ignored (1/4" = 1/4),
// and filler words drop out, so "1/4 to 3/8 npt" and "3/8 x 1/4 NPT" both work.

const WEIGHTS = { name: 3, partNumber: 3, vendor: 2, category: 2, tags: 2 };

export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}
const compact = (s) => s.replace(/[^a-z0-9]/g, '');
const hasDigit = (s) => /\d/.test(s);
const STOPWORDS = new Set(['to', 'x', 'by', 'and', 'with', 'for', 'the', 'a', 'an', 'of', 'in', 'inch', 'inches', '-', '&', '→']);
const DENOMINATORS = [2, 4, 8, 16, 32, 64];

const trimDecimal = (n) => String(Number(n.toFixed(6)));

/** Extra searchable spellings of the sizes in a text: "1/4" adds "0.25 .25"; "0.375" adds "3/8". */
function sizeAliases(text) {
  const out = [];
  for (const [, a, b] of text.matchAll(/(?<![\d.\/])(\d+)\/(\d+)(?![\d\/])/g)) {
    if (+b && DENOMINATORS.includes(+b)) {
      const d = trimDecimal(+a / +b);
      out.push(d, d.startsWith('0.') ? d.slice(1) : '');
    }
  }
  for (const [m] of text.matchAll(/(?<![\d\/])\d*\.\d+(?![\d\/])/g)) {
    const v = Number(m);
    for (const b of DENOMINATORS) {
      const a = Math.round(v * b);
      if (a > 0 && Math.abs(a / b - v) < 1e-9) {
        let g = a, h = b;
        while (h) [g, h] = [h, g % h];
        out.push(`${a / g}/${b / g}`);
        break;
      }
    }
  }
  return out.filter(Boolean);
}

function fieldsOf(part) {
  const fields = [
    ['name', part.name],
    ['partNumber', part.partNumber],
    ['vendor', part.vendor],
    ['category', part.category],
    ['tags', (part.tags ?? []).join(' ')],
    ['description', part.description],
    ['notes', part.notes],
    ['costNote', part.costNote],
    ['custom', (part.customFields ?? []).map((f) => `${f.key} ${f.value}`).join(' ')],
    ['links', (part.links ?? []).map((l) => l.label).join(' ')],
  ];
  return fields
    .filter(([, v]) => v)
    .map(([key, value]) => {
      const base = normalize(value);
      const text = [base, ...sizeAliases(base)].join(' ');
      return { weight: WEIGHTS[key] ?? 1, text, compact: compact(text), words: text.split(/[^a-z0-9./"#-]+/).filter(Boolean) };
    });
}

/** Precompute normalized fields; call again when the part list changes. */
export function buildIndex(parts) {
  return parts.map((part) => ({ part, fields: fieldsOf(part), name: normalize(part.name) }));
}

function editDistanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  // Damerau-Levenshtein (optimal string alignment), small strings only.
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return false;
  }
  return d[a.length][b.length] <= max;
}

/** Letters of `needle` appear in order in `hay`, not too spread out. */
function looseSubsequence(needle, hay) {
  for (let start = hay.indexOf(needle[0]); start !== -1; start = hay.indexOf(needle[0], start + 1)) {
    let i = 0;
    let j = start;
    for (; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
    if (i === needle.length && j - start <= needle.length * 2 + 1) return true;
  }
  return false;
}

/** Index of `token` in `text` where a number isn't cut in half (1/4 in "11/4" or "1/42" doesn't count). */
function numericIndex(text, token) {
  for (let i = text.indexOf(token); i !== -1; i = text.indexOf(token, i + 1)) {
    const before = text[i - 1] ?? ' ';
    const after = text[i + token.length] ?? ' ';
    if (!/[\d./]/.test(before) && !/\d/.test(after) && !(after === '/' && /^\d/.test(text.slice(i + token.length + 1)))) return i;
  }
  return -1;
}

function tokenScore(token, field) {
  const numeric = hasDigit(token);
  const idx = numeric ? numericIndex(field.text, token) : field.text.indexOf(token);
  if (idx !== -1) {
    if (field.words.includes(token)) return 1.2;
    const atWordStart = idx === 0 || /[^a-z0-9]/.test(field.text[idx - 1]);
    return atWordStart ? 1 : 0.8;
  }
  const ct = compact(token);
  // Part numbers typed without punctuation ("ss4006" for "SS-400-6"). Not for bare
  // numbers or fractions, where dropping the "/" or "." changes the meaning.
  if (ct.length >= 2 && (!numeric || (/[a-z]/.test(ct) && !token.includes('/'))) && field.compact.includes(ct)) return 0.7;
  if (numeric) return 0; // a near-miss on a size or part number is a different part
  if (ct.length >= 4) {
    const maxTypos = ct.length >= 8 ? 2 : 1;
    if (field.words.some((w) => w.length >= 3 && !hasDigit(w) && editDistanceAtMost(ct, compact(w), maxTypos))) return 0.5;
    if (looseSubsequence(ct, field.compact)) return 0.35;
  }
  return 0;
}

/** Split a query into words: "1/4x3/8" -> 1/4 3/8, inch marks dropped, filler words removed. */
function queryTokens(query) {
  const words = normalize(query)
    .replace(/(\d)\s*[x×*]\s*(?=\d)/g, '$1 ')
    .split(/\s+/)
    .map((w) => (/^[\d./]+(?:"|''|in|inch|inches)$/.test(w) ? w.replace(/(?:"|''|in|inch|inches)$/, '') : w))
    .filter(Boolean);
  const meaningful = words.filter((w) => !STOPWORDS.has(w));
  return meaningful.length ? meaningful : words;
}

/**
 * Filter and rank `index` (from buildIndex) by `query`. With an empty query the
 * original order is kept. `category` narrows to one category.
 */
export function search(index, query, { category = '' } = {}) {
  const tokens = queryTokens(query);
  const pool = category ? index.filter((e) => e.part.category === category) : index;
  if (!tokens.length) return pool.map((e) => e.part);
  const q = normalize(query).trim();
  const scored = [];
  for (const entry of pool) {
    let total = 0;
    for (const token of tokens) {
      let best = 0;
      for (const field of entry.fields) best = Math.max(best, field.weight * tokenScore(token, field));
      if (!best) {
        total = 0;
        break;
      }
      total += best;
    }
    if (!total) continue;
    if (entry.name.startsWith(q)) total += 4;
    else if (entry.name.includes(q)) total += 2;
    scored.push({ part: entry.part, total });
  }
  scored.sort((a, b) => b.total - a.total || a.part.name.localeCompare(b.part.name));
  return scored.map((s) => s.part);
}

export function formatCost(value) {
  if (value === null || value === undefined || value === '') return '';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}
