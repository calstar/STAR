import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import type { BomSection } from "./bom";
import { predictedCents } from "./bom";
import { parseSheet } from "./bom-import";
import { buildWorkbook, readWorkbook } from "./bom-xlsx";

// An export must read back as the same BOM: what the team downloads to send a
// sponsor or edit offline can be imported again without losing anything.

const line = (over: Partial<BomSection["lines"][number]>): BomSection["lines"][number] => ({
  id: "l",
  projectId: "p",
  kind: "part",
  name: "Part",
  partNumber: null,
  manufacturer: null,
  unitCostCents: null,
  quantity: null,
  shippingCents: null,
  realizedCents: null,
  supplier: null,
  url: null,
  spare: false,
  status: "planned",
  orderedAt: null,
  purchaserId: null,
  purchaserName: null,
  location: null,
  notes: null,
  taskId: null,
  taskNumber: null,
  taskProjectId: null,
  reimbursement: null,
  reimbursedElsewhere: false,
  position: 0,
  subpath: null,
  ...over,
});

const sections: BomSection[] = [
  {
    projectId: "rec",
    title: "LE4 Recovery",
    color: null,
    lines: [
      line({ name: 'Main Parachute (168" PDA)', unitCostCents: 153965, quantity: 1, shippingCents: 500, supplier: "Fruity Chutes", url: "https://shop.fruitychutes.com/x", notes: "Ask about 725lb Microline" }),
      line({ name: "Shockcord (200 ft)", unitCostCents: 140, quantity: 200, shippingCents: 500, status: "approved", manufacturer: "Mac Performance", partNumber: "KEV-200" }),
      line({ name: "Buffer", kind: "allowance", unitCostCents: 50000 }),
      line({ name: "Main Parachute (backup)", unitCostCents: 97800, quantity: 1, spare: true }),
    ],
  },
  {
    projectId: "av",
    title: "LE4 Avionics",
    color: null,
    lines: [
      line({ name: "DAQ PCBs", unitCostCents: 16753, quantity: 1, shippingCents: 15919, realizedCents: 32672, status: "received", orderedAt: "2026-09-29", purchaserId: "u1", location: "Snode", reimbursedElsewhere: true }),
      line({ name: "STM32H723", unitCostCents: 1410, quantity: 3, status: "ordered", subpath: "Flight Computer", purchaserName: "Steven" }),
    ],
  },
];

describe("export then import", async () => {
  const data = await buildWorkbook("LE4", sections, (id) => (id === "u1" ? "Alex K." : null));
  const book = await readWorkbook(data);

  it("writes a Summary and one sheet per section", () => {
    expect(book.map((s) => s.sheet)).toEqual(["Summary", "LE4 Recovery", "LE4 Avionics"]);
  });

  it("skips the Summary when read back", () => {
    expect(parseSheet("Summary", book[0].rows).lines).toEqual([]);
  });

  it("reads every line back with its fields", () => {
    for (const [i, s] of sections.entries()) {
      const back = parseSheet(s.title, book[i + 1].rows).lines;
      expect(back.map((l) => l.name)).toEqual(s.lines.map((l) => l.name));
      for (const [j, l] of s.lines.entries()) {
        const b = back[j];
        expect(b.kind).toBe(l.kind);
        expect(predictedCents(b)).toBe(predictedCents(l));
        expect(b.realizedCents).toBe(l.realizedCents);
        expect(b.status).toBe(l.status);
        expect(b.spare).toBe(l.spare);
        expect(b.url).toBe(l.url);
        expect(b.notes).toBe(l.notes);
        expect(b.partNumber).toBe(l.partNumber);
        expect(b.manufacturer).toBe(l.manufacturer);
        expect(b.orderedAt).toBe(l.orderedAt);
        expect(b.location).toBe(l.location);
        expect(b.reimbursedElsewhere).toBe(l.reimbursedElsewhere);
      }
    }
  });

  it("writes the purchaser's name, picked or typed", () => {
    const back = parseSheet("LE4 Avionics", book[2].rows).lines;
    expect(back.map((l) => l.purchaserName)).toEqual(["Alex K.", "Steven"]);
  });

  it("keeps the section total in the totals row", () => {
    const totalsRow = book[1].rows[1];
    const expected = sections[0].lines.reduce((n, l) => n + predictedCents(l), 0) / 100;
    expect(totalsRow[5]).toBeCloseTo(expected, 2);
  });
});

describe("reading a merged title cell (LE3's A1:A2)", () => {
  it("doesn't read the totals row as a line named after the title", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Airframe BOM");
    ws.addRow(["Camelot Airframe BOM", "Unit Cost", "Qty", "Predicted Cost", "Supplier"]);
    ws.addRow([null, null, null, 5582.41]);
    ws.addRow(["Fiberglass Nose Cone", 180.29, 1, 180.29, "Wildman Rocketry"]);
    ws.mergeCells("A1:A2");
    const [sheet] = await readWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(parseSheet(sheet.sheet, sheet.rows).lines.map((l) => l.name)).toEqual(["Fiberglass Nose Cone"]);
  });
});
