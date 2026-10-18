// Reading a BOM spreadsheet laid out like LE3 BOM.xlsx: one sheet per
// subsystem, item names in column A, a header row naming the columns (Unit
// Cost, Qty, Shipping & Tax, Supplier, Link, Approved?, Ordered?, Reimbursed?,
// Purchaser?, Location, Notes & Alternate Parts, ...). Columns are found by
// their header, not their position: the LE3 sheets put them in different
// places. Pure -- the .xlsx is opened in bom-xlsx.ts and handed here as rows of
// plain values -- so the rules can be tested against real rows.

import type { BomKind, BomStatus } from "@/lib/bom";
import { BOM_STATUSES } from "@/lib/bom";

export type Cell = string | number | boolean | Date | null | undefined;

/** A line read from a sheet, before it is given a project. */
export type BomDraft = {
  kind: BomKind;
  name: string;
  partNumber: string | null;
  manufacturer: string | null;
  unitCostCents: number | null;
  quantity: number | null;
  shippingCents: number | null;
  realizedCents: number | null;
  supplier: string | null;
  url: string | null;
  spare: boolean;
  status: BomStatus;
  orderedAt: string | null;
  purchaserName: string | null;
  location: string | null;
  notes: string | null;
  reimbursedElsewhere: boolean;
};

export type ParsedSheet = {
  sheet: string;
  lines: BomDraft[];
  /** Why a sheet or a row was left out, for the import preview. */
  warnings: string[];
};

type Col =
  | "unit"
  | "qty"
  | "predicted"
  | "realized"
  | "subtotal"
  | "total"
  | "shipping"
  | "supplier"
  | "link"
  | "approved"
  | "ordered"
  | "reimbursed"
  | "purchaser"
  | "location"
  | "notes"
  | "date"
  | "partNumber"
  | "manufacturer"
  | "status";

// Header text (lower-case, punctuation dropped) -> column. First match wins.
const HEADERS: [RegExp, Col][] = [
  [/^unit (cost|price)/, "unit"],
  [/^(qty|quantity)/, "qty"],
  [/^predicted/, "predicted"],
  [/^(realized|actual)/, "realized"],
  [/^total cost$/, "subtotal"],
  [/^total$/, "total"],
  [/^shipping/, "shipping"],
  [/^(supplier|vendor)/, "supplier"],
  [/^(link|url)/, "link"],
  [/^approved/, "approved"],
  [/^ordered$/, "ordered"],
  [/^reimbursed/, "reimbursed"],
  [/^purchaser/, "purchaser"],
  [/^location/, "location"],
  [/^notes/, "notes"],
  [/^(date|ordered on)/, "date"],
  [/^part (number|no|#)/, "partNumber"],
  [/^(manufacturer|mfr|mfg|make|brand)/, "manufacturer"],
  [/^status$/, "status"],
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[?:&.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function columnOf(header: Cell): Col | null {
  if (typeof header !== "string") return null;
  const h = norm(header);
  for (const [re, col] of HEADERS) if (re.test(h)) return col;
  return null;
}

function text(c: Cell): string | null {
  if (c === null || c === undefined) return null;
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  const s = String(c).trim();
  return s ? s : null;
}

/** A money cell -> cents. Numbers as typed in Excel, or text like "$1,539.65". */
function cents(c: Cell): number | null {
  if (typeof c === "number") return Number.isFinite(c) ? Math.round(c * 100) : null;
  const s = text(c)?.replace(/[$,\s]/g, "");
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

function num(c: Cell): number | null {
  if (typeof c === "number") return Number.isFinite(c) ? c : null;
  const s = text(c)?.replace(/,/g, "");
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** The sheets' tick columns hold 1/0; people also type yes, y, x, ✓, TRUE. */
function ticked(c: Cell): boolean {
  if (c === true) return true;
  if (typeof c === "number") return c > 0;
  const s = text(c)?.toLowerCase();
  return !!s && ["1", "yes", "y", "x", "✓", "✔", "true", "done"].includes(s);
}

// Excel stores a date as days since 1899-12-30 when the cell isn't date-formatted.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
function date(c: Cell): string | null {
  if (c instanceof Date) return Number.isNaN(c.getTime()) ? null : c.toISOString().slice(0, 10);
  if (typeof c === "number" && c > 20000 && c < 80000)
    return new Date(EXCEL_EPOCH + Math.round(c) * 86_400_000).toISOString().slice(0, 10);
  const s = text(c);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function url(c: Cell): string | null {
  const s = text(c);
  return s && /^https?:\/\//i.test(s) ? s : null;
}

function statusOf(row: Partial<Record<Col, Cell>>): BomStatus {
  const s = text(row.status)?.toLowerCase();
  if (s && (BOM_STATUSES as readonly string[]).includes(s)) return s as BomStatus;
  if (ticked(row.ordered)) return "ordered";
  if (ticked(row.approved)) return "approved";
  return "planned";
}

/**
 * The lines on one sheet. The header row is the first of the top ten that names
 * a cost or supplier column. Below it: a row with no name (the totals row) or a
 * footnote ("*Note ...") is skipped; a name with no numbers at all is a heading,
 * and "With Backups" / "Spares" headings mark the lines under them as spares; a
 * line with only a predicted cost ("Buffer") is an allowance. A line with no
 * unit cost but a "Total Cost" (LE3's Avionics sheet) is one unit at that cost.
 * The sheet's own Predicted column is not kept -- the BOM computes it.
 */
export function parseSheet(sheet: string, rows: Cell[][]): ParsedSheet {
  const warnings: string[] = [];
  const headerAt = rows.slice(0, 10).findIndex((r) => {
    const cols = r.map(columnOf);
    return cols.includes("unit") || cols.includes("qty") || cols.includes("supplier") || cols.includes("subtotal");
  });
  if (headerAt < 0) return { sheet, lines: [], warnings: ["No BOM columns found (Unit Cost, Qty, Supplier ...), so the sheet was skipped."] };

  const cols = new Map<Col, number>();
  rows[headerAt].forEach((h, i) => {
    const col = i === 0 ? null : columnOf(h);
    if (col && !cols.has(col)) cols.set(col, i);
  });

  const lines: BomDraft[] = [];
  let spares = false;
  for (const raw of rows.slice(headerAt + 1)) {
    const name = text(raw[0]);
    if (!name || name.startsWith("*")) continue;
    const row: Partial<Record<Col, Cell>> = {};
    for (const [col, i] of cols) row[col] = raw[i];

    const unit = cents(row.unit);
    const qty = num(row.qty);
    const subtotal = cents(row.subtotal);
    const predicted = cents(row.predicted);
    const realized = cents(row.realized) ?? cents(row.total);
    const shipping = cents(row.shipping);

    if (unit === null && qty === null && subtotal === null && predicted === null && realized === null) {
      // A heading inside the sheet.
      spares = /backup|spare/i.test(name);
      continue;
    }

    const allowance = unit === null && qty === null && subtotal === null && predicted !== null;
    lines.push({
      kind: allowance ? "allowance" : "part",
      name: name.slice(0, 200),
      partNumber: text(row.partNumber),
      manufacturer: text(row.manufacturer),
      unitCostCents: allowance ? predicted : (unit ?? subtotal),
      quantity: allowance ? null : (qty ?? 1),
      shippingCents: allowance ? null : shipping,
      realizedCents: realized,
      supplier: text(row.supplier),
      url: url(row.link),
      spare: spares,
      status: statusOf(row),
      orderedAt: date(row.date),
      purchaserName: text(row.purchaser),
      location: text(row.location),
      notes: text(row.notes),
      reimbursedElsewhere: ticked(row.reimbursed),
    });
  }
  if (lines.length === 0) warnings.push("No lines found under the header row.");
  return { sheet, lines, warnings };
}

/**
 * The project a sheet most likely belongs to: the candidate sharing the most
 * words with the sheet's name ("Avionics BOM" -> "LE4 Avionics"), ignoring
 * "BOM" and the like. Null when nothing matches, so the caller can default to
 * the project being imported into.
 */
export function suggestProject(
  sheet: string,
  candidates: { id: string; name: string }[],
): string | null {
  const IGNORE = new Set(["bom", "the", "of", "and", "parts", "list", "le3", "le4"]);
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 1 && !IGNORE.has(w)),
    );
  const want = words(sheet);
  let best: { id: string; score: number } | null = null;
  for (const c of candidates) {
    const score = [...words(c.name)].filter((w) => want.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { id: c.id, score };
  }
  return best?.id ?? null;
}
