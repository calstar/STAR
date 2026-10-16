import { describe, expect, it } from "vitest";

import {
  type BomLine,
  bomRollsUp,
  parseBomValue,
  predictedCents,
  reimbursedState,
  sectionsFor,
  showBomValue,
  statusChangeNeedsApprover,
  summarize,
} from "./bom";
import { buildTree, type TreeNode } from "./project-tree";

const line = (over: Partial<BomLine> = {}): BomLine => ({
  id: "l",
  projectId: "LE4",
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
  ...over,
});

const filing = (status: string, callinkStatus: string | null = null, deleted: string | null = null) => ({
  id: "r",
  number: 7,
  status,
  callinkStatus,
  callinkDeletedOn: deleted,
});

describe("predictedCents", () => {
  it("is unit x qty + shipping for a part", () => {
    // LE3 Recovery: Shockcord, $1.40/ft x 200 ft, $5 shipping.
    expect(predictedCents(line({ unitCostCents: 140, quantity: 200, shippingCents: 500 }))).toBe(28500);
  });
  it("counts a part with no quantity as one", () => {
    expect(predictedCents(line({ unitCostCents: 31931 }))).toBe(31931);
  });
  it("rounds fractional quantities to the cent", () => {
    expect(predictedCents(line({ unitCostCents: 333, quantity: 2.5 }))).toBe(833);
  });
  it("is the lump sum for an allowance, ignoring quantity and shipping", () => {
    expect(predictedCents(line({ kind: "allowance", unitCostCents: 50000, quantity: 3, shippingCents: 900 }))).toBe(50000);
  });
  it("is zero for a line nobody has priced", () => {
    expect(predictedCents(line())).toBe(0);
  });
});

describe("reimbursedState", () => {
  it("is none with no filing", () => expect(reimbursedState(line())).toBe("none"));
  it("is filed while the filing is in flight", () => {
    expect(reimbursedState(line({ reimbursement: filing("pending_approval") }))).toBe("filed");
    expect(reimbursedState(line({ reimbursement: filing("submitted", "Approved") }))).toBe("filed");
  });
  it("is reimbursed only once CalLink says Completed", () => {
    expect(reimbursedState(line({ reimbursement: filing("submitted", "Completed") }))).toBe("reimbursed");
  });
  it("is none again when the filing died, so the line can be filed again", () => {
    for (const r of [
      filing("rejected"),
      filing("cancelled"),
      filing("submitted", "Denied"),
      filing("submitted", "Canceled"),
      filing("submitted", "Completed", "2026-10-01"),
    ])
      expect(reimbursedState(line({ reimbursement: r }))).toBe("none");
  });
  it("trusts a line marked reimbursed outside STAR", () => {
    expect(reimbursedState(line({ reimbursedElsewhere: true }))).toBe("reimbursed");
  });
});

describe("summarize", () => {
  const lines = [
    line({ id: "a", unitCostCents: 1000, quantity: 2, status: "planned" }), // 20.00
    line({ id: "b", unitCostCents: 500, shippingCents: 100, status: "approved" }), // 6.00
    line({ id: "c", unitCostCents: 300, status: "ordered", realizedCents: 350 }), // 3.00, paid 3.50
    line({ id: "d", unitCostCents: 200, status: "received", realizedCents: 200, reimbursedElsewhere: true }),
    line({ id: "e", kind: "allowance", unitCostCents: 5000, status: "approved" }), // 50.00
    line({ id: "f", unitCostCents: 9900, spare: true }), // 99.00 spare
  ];
  it("adds up predicted, realized and approved", () => {
    const s = summarize(lines);
    expect(s.predictedCents).toBe(2000 + 600 + 300 + 200 + 5000 + 9900);
    expect(s.realizedCents).toBe(550);
    expect(s.approvedCents).toBe(600 + 300 + 200 + 5000);
  });
  it("counts ordered parts among parts, leaving allowances out", () => {
    const s = summarize(lines);
    expect(s.parts).toBe(5);
    expect(s.orderedParts).toBe(2);
  });
  it("owes what was paid and has not come back", () => {
    expect(summarize(lines).owedCents).toBe(350);
  });
  it("can leave spares out", () => {
    expect(summarize(lines, { includeSpares: false }).predictedCents).toBe(2000 + 600 + 300 + 200 + 5000);
  });
});

describe("statusChangeNeedsApprover", () => {
  it("guards leaving and returning to Planned", () => {
    expect(statusChangeNeedsApprover("planned", "approved")).toBe(true);
    expect(statusChangeNeedsApprover("planned", "ordered")).toBe(true);
    expect(statusChangeNeedsApprover("received", "planned")).toBe(true);
  });
  it("leaves ordering and receiving to anyone", () => {
    expect(statusChangeNeedsApprover("approved", "ordered")).toBe(false);
    expect(statusChangeNeedsApprover("ordered", "received")).toBe(false);
    expect(statusChangeNeedsApprover("planned", "planned")).toBe(false);
  });
});

// LE4 ─┬─ Avionics ─┬─ FC
//      │            └─ Video
//      ├─ Solid
//      └─ Old (archived)
// SSEP3
const node = (id: string, parentId: string | null, archived = false): TreeNode => ({
  id,
  name: id,
  color: null,
  parentId,
  archived,
});
const tree = buildTree([
  node("LE4", null),
  node("Avionics", "LE4"),
  node("FC", "Avionics"),
  node("Video", "Avionics"),
  node("Solid", "LE4"),
  node("Old", "LE4", true),
  node("SSEP3", null),
]);

describe("sectionsFor", () => {
  const lines = [
    line({ id: "own", projectId: "LE4" }),
    line({ id: "av", projectId: "Avionics", position: 2 }),
    line({ id: "fc", projectId: "FC", position: 1 }),
    line({ id: "vid", projectId: "Video" }),
    line({ id: "solid", projectId: "Solid" }),
    line({ id: "old", projectId: "Old" }),
    line({ id: "other", projectId: "SSEP3" }),
  ];

  it("on the parent: own lines first, then one section per child with everything under it", () => {
    const s = sectionsFor(tree, "LE4", lines);
    expect(s.map((x) => [x.projectId, x.lines.map((l) => l.id)])).toEqual([
      [null, ["own"]],
      ["Avionics", ["av", "fc", "vid"]],
      ["Solid", ["solid"]],
    ]);
    expect(s[0].title).toBe("LE4 (general)");
  });

  it("labels a line deeper than its section with its path", () => {
    const av = sectionsFor(tree, "LE4", lines).find((x) => x.projectId === "Avionics")!;
    expect(av.lines.map((l) => l.subpath)).toEqual([null, "FC", "Video"]);
  });

  it("on a subproject: only its own lines, not its children's", () => {
    const s = sectionsFor(tree, "Avionics", lines);
    expect(s.map((x) => [x.projectId, x.lines.map((l) => l.id)])).toEqual([[null, ["av"]]]);
  });

  it("keeps empty sections when asked, for a subproject with nothing on it yet", () => {
    const s = sectionsFor(tree, "LE4", [line({ id: "fc", projectId: "FC" })], { includeEmpty: true });
    expect(s.map((x) => [x.projectId, x.lines.length])).toEqual([
      [null, 0],
      ["Avionics", 1],
      ["Solid", 0],
    ]);
  });

  it("with a parent: only its own lines, even with subprojects of its own", () => {
    const deep = buildTree([node("LE4", null), node("Engine", "LE4"), node("Chamber", "Engine"), node("Injector", "Chamber")]);
    const ls = [
      line({ id: "e", projectId: "Engine" }),
      line({ id: "c", projectId: "Chamber" }),
      line({ id: "i", projectId: "Injector" }),
    ];
    const ids = (root: string) => sectionsFor(deep, root, ls, { includeEmpty: true }).map((x) => [x.projectId, x.lines.map((l) => l.id)]);
    expect(ids("Engine")).toEqual([[null, ["e"]]]);
    expect(ids("Chamber")).toEqual([[null, ["c"]]]);
    // Only the top-level project takes in everything below it.
    expect(ids("LE4")).toEqual([
      [null, []],
      ["Engine", ["e", "c", "i"]],
    ]);
    expect([bomRollsUp(deep, "LE4"), bomRollsUp(deep, "Engine"), bomRollsUp(deep, "Chamber")]).toEqual([true, false, false]);
  });

  it("on a leaf: just its own lines", () => {
    expect(sectionsFor(tree, "FC", lines).map((x) => x.lines.map((l) => l.id))).toEqual([["fc"]]);
  });

  it("counts each line once at every level", () => {
    const total = (root: string) =>
      summarize(sectionsFor(tree, root, lines).flatMap((x) => x.lines)).lines;
    expect(total("FC")).toBe(1);
    expect(total("Avionics")).toBe(1);
    expect(total("LE4")).toBe(5); // own + 3 avionics + solid; archived Old and SSEP3 left out
  });
});

describe("parseBomValue", () => {
  it("takes money as typed", () => {
    expect(parseBomValue("unitCostCents", "$1,539.65")).toBe(153965);
    expect(parseBomValue("shippingCents", "")).toBeNull();
    expect(() => parseBomValue("realizedCents", "about 12")).toThrow(/amount/);
  });
  it("takes fractional quantities and refuses zero", () => {
    expect(parseBomValue("quantity", "200")).toBe(200);
    expect(parseBomValue("quantity", "2.5")).toBe(2.5);
    expect(() => parseBomValue("quantity", "0")).toThrow();
    expect(() => parseBomValue("quantity", "-1")).toThrow();
  });
  it("requires a name", () => {
    expect(() => parseBomValue("name", "  ")).toThrow(/name/);
  });
  it("accepts #412 for a task", () => {
    expect(parseBomValue("taskNumber", "#412")).toBe(412);
    expect(() => parseBomValue("taskNumber", "abc")).toThrow();
  });
  it("only takes web links", () => {
    expect(() => parseBomValue("url", "javascript:alert(1)")).toThrow();
    expect(parseBomValue("url", "https://www.mcmaster.com/91290A231/")).toBe("https://www.mcmaster.com/91290A231/");
  });
  it("refuses an unknown status", () => {
    expect(() => parseBomValue("status", "bought")).toThrow();
  });
});

describe("showBomValue", () => {
  it("renders money, statuses and blanks for History", () => {
    expect(showBomValue("unitCostCents", 153965)).toBe("$1,539.65");
    expect(showBomValue("status", "ordered")).toBe("Ordered");
    expect(showBomValue("notes", null)).toBe("—");
    expect(showBomValue("taskNumber", 412)).toBe("#412");
  });
});
