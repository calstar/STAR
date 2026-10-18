import { describe, expect, it } from "vitest";

import { parseSheet, suggestProject, type Cell } from "./bom-import";

// Rows as they come out of LE3 BOM.xlsx, trimmed to the columns that matter.

const RECOVERY_HEADER: Cell[] = [" ", "Unit Cost", "Qty", "Predicted Cost", "Realized Cost", "Shipping & Tax Cost", "Supplier", "Link", "Approved?", "Ordered?", "Reimbursed?", "Purchaser?", "Location", "Notes & Alternate Parts"];
const recovery: Cell[][] = [
  RECOVERY_HEADER,
  [null, null, null, 3512.88, 0], // the totals row
  ["Main Parachute (168\" PDA)", 1539.65, 1, 1539.65, null, 5, "Fruity Chutes", "https://shop.fruitychutes.com/x", 0, 0, 0, null, null, "Ask about 725lb Microline"],
  ["Shockcord (200ft)", 1.4, 200, 280, null, 5, "Mac Performance", "https://macperformancerocketry.com/x", 0, 0, 0],
  ["Buffer", null, null, 500, null, null, null, null, null, null, null, null, null, "Testing, small backups, tool replacements"],
  [null],
  ["With Backups"],
  ["Main Parachute", 978, 1, 978],
  [null, null, null, 4453.12],
];

const AIRFRAME_HEADER: Cell[] = ["Camelot Airframe BOM", "Unit Cost", "Qty", "Predicted Cost", "Shipping & Tax Cost", "Supplier", "Link", "Approved?", "Ordered?", "Reimbursed?", "Purchaser?", "Location", "Notes & Alternate Parts"];
const airframe: Cell[][] = [
  AIRFRAME_HEADER,
  [null, null, null, 5582.41],
  ["Fiberglass Nose Cone", 180.29, 1, 231.04, 50.75, "Wildman Rocketry", null, 1, 1, 1, "Steven", "Kush's house"],
  ["Fiberglass Motor Mount Tube", 77.5, 1, 145, 67.5, "Mach 1 Rocketry ", null, 1, 1, 0, "Steven", "Steven's house"],
  ["2'x2' Aluminum Stock", 78.81, 1, 78.81, 0, "Jacobs Store ", null, 0, 0, 0],
  ["*Note this cost comprises a full system failure and replenishing parts."],
];

const AVIONICS_HEADER: Cell[] = ["LE3 Avionics BOM", "Date", "Unit Cost", "Qty", "Predicted Cost", "Total Cost", "Shipping, Tariffs, and Tax", "Total", "Supplier", "Link", "Approved?", "Ordered?", "Reimbursed?", "Purchaser?", "Location", "Notes & Alternate Parts"];
const avionics: Cell[][] = [
  AVIONICS_HEADER,
  [null, null, null, null, null, 915.4],
  ["DAQ PCBs", 45929, null, null, null, 167.53, 159.19, 326.72, "JLCPCB", null, 1, 1, 0, null, "Snode "],
  ["Thermocouples ", null, null, null, null, 19.62, null, 19.62, "Aliexpress", null, 1, 1, 1, null, "Snode/RFS"],
  [null, null, null, null, null, null, null, null, null, null, 0, 0, 0],
];

describe("parseSheet: LE3 Recovery", () => {
  const { lines, warnings } = parseSheet("Recovery BOM", recovery);

  it("skips the totals rows and the heading, keeps every line", () => {
    expect(lines.map((l) => l.name)).toEqual(["Main Parachute (168\" PDA)", "Shockcord (200ft)", "Buffer", "Main Parachute"]);
    expect(warnings).toEqual([]);
  });
  it("reads cost, quantity, shipping, supplier, link and notes by header", () => {
    expect(lines[0]).toMatchObject({
      kind: "part",
      unitCostCents: 153965,
      quantity: 1,
      shippingCents: 500,
      supplier: "Fruity Chutes",
      url: "https://shop.fruitychutes.com/x",
      notes: "Ask about 725lb Microline",
      status: "planned",
      spare: false,
    });
    expect(lines[1]).toMatchObject({ unitCostCents: 140, quantity: 200 });
  });
  it("makes a row with only a predicted cost an allowance", () => {
    expect(lines[2]).toMatchObject({ kind: "allowance", unitCostCents: 50000, quantity: null });
  });
  it("marks lines under 'With Backups' as spares", () => {
    expect(lines[3]).toMatchObject({ spare: true, unitCostCents: 97800 });
  });
});

describe("parseSheet: LE3 Airframe", () => {
  const { lines } = parseSheet("Airframe BOM", airframe);

  it("drops the footnote", () => {
    expect(lines).toHaveLength(3);
  });
  it("turns the tick columns into a status, purchaser and reimbursed flag", () => {
    expect(lines[0]).toMatchObject({ status: "ordered", purchaserName: "Steven", location: "Kush's house", reimbursedElsewhere: true });
    expect(lines[1]).toMatchObject({ status: "ordered", reimbursedElsewhere: false });
    expect(lines[2]).toMatchObject({ status: "planned" });
  });
  it("takes shipping from its own column wherever it sits", () => {
    expect(lines[0]).toMatchObject({ unitCostCents: 18029, shippingCents: 5075 });
  });
});

describe("parseSheet: LE3 Avionics", () => {
  const { lines } = parseSheet("Avionics BOM", avionics);

  it("reads a Total Cost line as one unit, its Total as what was paid", () => {
    expect(lines[0]).toMatchObject({ unitCostCents: 16753, quantity: 1, shippingCents: 15919, realizedCents: 32672 });
  });
  it("reads an Excel serial date", () => {
    expect(lines[0].orderedAt).toBe("2025-09-29");
    expect(lines[1].orderedAt).toBeNull();
  });
  it("skips the empty row that only has ticks", () => {
    expect(lines.map((l) => l.name)).toEqual(["DAQ PCBs", "Thermocouples"]);
  });
});

describe("parseSheet: other sheets", () => {
  it("skips a sheet with no BOM header, saying why", () => {
    const r = parseSheet("Summary", [["Section", "Predicted", "Realized"], ["Avionics", 1, 2]]);
    expect(r.lines).toEqual([]);
    expect(r.warnings[0]).toMatch(/No BOM columns/);
  });
  it("takes an explicit Status column over the ticks (our own export)", () => {
    const r = parseSheet("Avionics", [
      ["Item", "Unit Cost", "Qty", "Approved?", "Ordered?", "Status"],
      ["STM32", 14.1, 3, 1, 1, "Received"],
    ]);
    expect(r.lines[0].status).toBe("received");
  });
  it("reads a Manufacturer column (also Mfr / Make / Brand)", () => {
    const r = parseSheet("Avionics", [
      ["Item", "Mfr", "Part #", "Unit Cost"],
      ["STM32H723", "STMicroelectronics", "497-STM32H723ZGT6-ND", 14.1],
    ]);
    expect(r.lines[0]).toMatchObject({ manufacturer: "STMicroelectronics", partNumber: "497-STM32H723ZGT6-ND" });
  });
  it("ignores a link cell that isn't a web link", () => {
    const r = parseSheet("X", [["Item", "Unit Cost", "Link"], ["A", 1, "javascript:alert(1)"]]);
    expect(r.lines[0].url).toBeNull();
  });
});

describe("suggestProject", () => {
  const candidates = [
    { id: "eng", name: "LE4 Engine" },
    { id: "av", name: "LE4 Avionics" },
    { id: "fc", name: "Flight Computer" },
  ];
  it("matches on shared words, ignoring BOM and the vehicle name", () => {
    expect(suggestProject("Avionics BOM", candidates)).toBe("av");
    expect(suggestProject("Engine", candidates)).toBe("eng");
  });
  it("is null when nothing matches", () => {
    expect(suggestProject("Recovery BOM", candidates)).toBeNull();
    expect(suggestProject("LE3 BOM", candidates)).toBeNull();
  });
});
