// CSV / TSV in, rows of strings out. Pasted from a Google Sheet a range arrives
// tab-separated; a downloaded export arrives comma-separated with quotes. Pure.

/** Tab when the first line has a tab, else comma. */
export function detectDelimiter(text: string): "\t" | "," {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  return first.includes("\t") ? "\t" : ",";
}

/**
 * RFC 4180: quoted fields may hold the delimiter, newlines and "" for a quote.
 * `keepBlank` keeps all-empty rows so row numbers match the spreadsheet's (the
 * import preview says "row 12"); otherwise they are dropped.
 */
export function parseDelimited(text: string, delimiter = detectDelimiter(text), keepBlank = false): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return keepBlank ? rows : rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/** One CSV line for an export: quotes a field only when it needs them. */
export function toCsvLine(values: (string | number | null | undefined)[]): string {
  return values
    .map((v) => {
      const s = v == null ? "" : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}
