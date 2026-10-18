import ExcelJS from "exceljs";

import { type BomSection, BOM_STATUS_LABEL, predictedCents, reimbursedState } from "@/lib/bom";
import type { Cell } from "@/lib/bom-import";

// Opening and writing .xlsx files. The rules for what a row means live in
// bom-import.ts; this file only turns cells into plain values and back.

/** A cell's plain value: the result of a formula, the text of rich text, the
 * address of a link whose text is itself the link. */
function plain(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v instanceof Date) return v;
  if (typeof v === "object") {
    if ("result" in v) return plain((v as { result?: ExcelJS.CellValue }).result ?? null);
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("hyperlink" in v) {
      const text = typeof v.text === "string" ? v.text : "";
      return !text || /^https?:\/\//i.test(text) ? v.hyperlink : text;
    }
    if ("error" in v) return null;
  }
  return null;
}

/** Every sheet's rows as plain values, row 1 first; column A is index 0. */
export async function readWorkbook(data: ArrayBuffer): Promise<{ sheet: string; rows: Cell[][] }[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  return wb.worksheets.map((ws) => {
    const rows: Cell[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells: Cell[] = [];
      for (let c = 1; c <= Math.max(row.cellCount, 1); c++) {
        const cell = row.getCell(c);
        // A merged range reports its value in every cell it covers; only its
        // top-left cell really holds it. (LE3 merges A1:A2, which otherwise
        // turns the totals row into a line named after the sheet.)
        cells.push(cell.isMerged && cell.master.address !== cell.address ? null : plain(cell.value));
      }
      rows.push(cells);
    }
    return { sheet: ws.name, rows };
  });
}

// The LE3 columns, in the LE3 order, then what STAR adds. Re-importing an
// export reads every one of them back (bom-import.ts finds columns by header).
const COLUMNS: { header: string; width: number }[] = [
  { header: "Item", width: 34 },
  { header: "Subproject", width: 18 },
  { header: "Part #", width: 14 },
  { header: "Unit Cost", width: 11 },
  { header: "Qty", width: 7 },
  { header: "Predicted Cost", width: 14 },
  { header: "Realized Cost", width: 13 },
  { header: "Shipping & Tax Cost", width: 12 },
  { header: "Supplier", width: 18 },
  { header: "Link", width: 30 },
  { header: "Approved?", width: 10 },
  { header: "Ordered?", width: 9 },
  { header: "Reimbursed?", width: 11 },
  { header: "Purchaser?", width: 14 },
  { header: "Location", width: 14 },
  { header: "Notes & Alternate Parts", width: 34 },
  { header: "Status", width: 10 },
  { header: "Ordered on", width: 11 },
  // Last, so the cost formulas' column letters (D, E, F, H) stay put.
  { header: "Manufacturer", width: 18 },
];
const MONEY = '"$"#,##0.00';

function sheetName(title: string, used: Set<string>): string {
  const base = title.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 28) || "Sheet";
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  used.add(name.toLowerCase());
  return name;
}

/**
 * A workbook laid out like LE3 BOM.xlsx: a Summary sheet, then one sheet per
 * section with a header row, a totals row, and the lines; spares follow a
 * "With Backups" heading as they did in LE3's Recovery sheet.
 */
export async function buildWorkbook(
  projectName: string,
  sections: BomSection[],
  purchaserOf: (id: string | null) => string | null,
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "STARProject";
  const used = new Set<string>(["summary"]);
  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: `${projectName} BOM`, width: 30 },
    { header: "Lines", width: 8 },
    { header: "Predicted Cost", width: 15, style: { numFmt: MONEY } },
    { header: "Realized Cost", width: 15, style: { numFmt: MONEY } },
  ];
  summary.getRow(1).font = { bold: true };

  for (const s of sections) {
    const name = sheetName(s.title, used);
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 2 }] });
    ws.columns = COLUMNS.map((c) => ({ header: c.header, width: c.width }));
    ws.getRow(1).font = { bold: true };
    for (const col of [4, 6, 7, 8]) ws.getColumn(col).numFmt = MONEY;

    const first = 3;
    const ordered = [...s.lines.filter((l) => !l.spare), ...s.lines.filter((l) => l.spare)];
    let r = first;
    let headed = false;
    for (const l of ordered) {
      if (l.spare && !headed) {
        ws.getRow(r++).getCell(1).value = "With Backups";
        headed = true;
      }
      const row = ws.getRow(r);
      const predicted = predictedCents(l) / 100;
      const allowance = l.kind === "allowance";
      row.values = [
        l.name,
        l.subpath ?? "",
        l.partNumber ?? "",
        allowance || l.unitCostCents === null ? null : l.unitCostCents / 100,
        allowance ? null : (l.quantity ?? 1),
        allowance || l.unitCostCents === null
          ? predicted
          : { formula: `D${r}*E${r}+H${r}`, result: predicted },
        l.realizedCents === null ? null : l.realizedCents / 100,
        l.shippingCents === null ? null : l.shippingCents / 100,
        l.supplier ?? "",
        l.url ? { text: l.url, hyperlink: l.url } : "",
        l.status === "planned" ? 0 : 1,
        l.status === "ordered" || l.status === "received" ? 1 : 0,
        reimbursedState(l) === "reimbursed" ? 1 : 0,
        purchaserOf(l.purchaserId) ?? l.purchaserName ?? "",
        l.location ?? "",
        l.notes ?? "",
        BOM_STATUS_LABEL[l.status],
        l.orderedAt ?? "",
        l.manufacturer ?? "",
      ];
      r++;
    }
    const last = Math.max(r - 1, first);
    const totals = ws.getRow(2);
    const sumOf = (col: string, cents: number) => ({ formula: `SUM(${col}${first}:${col}${last})`, result: cents / 100 });
    const predictedTotal = s.lines.reduce((n, l) => n + predictedCents(l), 0);
    const realizedTotal = s.lines.reduce((n, l) => n + (l.realizedCents ?? 0), 0);
    totals.getCell(6).value = sumOf("F", predictedTotal);
    totals.getCell(7).value = sumOf("G", realizedTotal);
    totals.font = { bold: true };

    summary.addRow([s.title, s.lines.length, predictedTotal / 100, realizedTotal / 100]);
  }
  const n = sections.length;
  if (n > 0) {
    const all = sections.flatMap((s) => s.lines);
    const p = all.reduce((t, l) => t + predictedCents(l), 0) / 100;
    const z = all.reduce((t, l) => t + (l.realizedCents ?? 0), 0) / 100;
    const total = summary.addRow([
      "Total",
      all.length,
      { formula: `SUM(C2:C${n + 1})`, result: p },
      { formula: `SUM(D2:D${n + 1})`, result: z },
    ]);
    total.font = { bold: true };
  }
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
