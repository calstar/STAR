// Instant fuzzy search over every part field, shared by the hub and the Onshape panel.
//
// Every word of the query must match some field. A word matches a field by (best first):
// whole word > word prefix > substring > same characters ignoring punctuation
// ("ss4006" finds "SS-400-6") > one or two typos ("vlave") > letters in order ("tbun").
// Name and part number weigh most, then vendor/category/tags, then everything else.

const WEIGHTS = { name: 3, partNumber: 3, vendor: 2, category: 2, tags: 2 };

export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}
const compact = (s) => s.replace(/[^a-z0-9]/g, '');

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
      const text = normalize(value);
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

function tokenScore(token, field) {
  const idx = field.text.indexOf(token);
  if (idx !== -1) {
    if (field.words.includes(token)) return 1.2;
    const atWordStart = idx === 0 || /[^a-z0-9]/.test(field.text[idx - 1]);
    return atWordStart ? 1 : 0.8;
  }
  const ct = compact(token);
  if (ct.length >= 2 && field.compact.includes(ct)) return 0.7;
  if (ct.length >= 4) {
    const maxTypos = ct.length >= 8 ? 2 : 1;
    if (field.words.some((w) => w.length >= 3 && editDistanceAtMost(ct, compact(w), maxTypos))) return 0.5;
  }
  if (ct.length >= 3 && looseSubsequence(ct, field.compact)) return 0.35;
  return 0;
}

/**
 * Filter and rank `index` (from buildIndex) by `query`. With an empty query the
 * original order is kept. `category` narrows to one category.
 */
export function search(index, query, { category = '' } = {}) {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
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
