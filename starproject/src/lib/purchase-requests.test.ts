import { describe, expect, it } from "vitest";

import {
  itemApproved,
  itemsToApprove,
  canCancel,
  canDecide,
  changedSinceRequested,
  requestProblem,
  requestTotal,
  snapshotOf,
} from "./purchase-requests";

const pvp = { userId: "p", pvp: true };
const maker = { userId: "m", pvp: false };
const other = { userId: "o", pvp: false };
const pending = { status: "pending" as const, createdById: "m" };

describe("who may act", () => {
  it("only a PVP decides, and only while waiting", () => {
    expect(canDecide(pending, pvp)).toBe(true);
    expect(canDecide(pending, maker)).toBe(false);
    expect(canDecide({ ...pending, status: "approved" }, pvp)).toBe(false);
    expect(canDecide({ ...pending, status: "rejected" }, pvp)).toBe(false);
  });
  it("the maker or a PVP cancels, only while waiting", () => {
    expect(canCancel(pending, maker)).toBe(true);
    expect(canCancel(pending, pvp)).toBe(true);
    expect(canCancel(pending, other)).toBe(false);
    expect(canCancel({ ...pending, status: "approved" }, maker)).toBe(false);
  });
});

describe("requestProblem", () => {
  const lines = [
    { id: "a", name: "Drogue", status: "planned" as const },
    { id: "b", name: "M2500 Motor", status: "approved" as const },
    { id: "c", name: "Shock cord", status: "planned" as const },
  ];
  it("accepts Planned lines not already requested", () => {
    expect(requestProblem(lines, ["a", "c"], new Set())).toBeNull();
  });
  it("refuses an empty request", () => {
    expect(requestProblem(lines, [], new Set())).toMatch(/at least one/);
  });
  it("refuses a line past Planned", () => {
    expect(requestProblem(lines, ["a", "b"], new Set())).toMatch(/M2500 Motor.*past Planned/);
  });
  it("refuses a line already on a waiting request", () => {
    expect(requestProblem(lines, ["c"], new Set(["c"]))).toMatch(/Shock cord.*already on a request/);
  });
  it("refuses a line that no longer exists", () => {
    expect(requestProblem(lines, ["zzz"], new Set())).toMatch(/gone/);
  });
});

describe("snapshots", () => {
  const line = {
    id: "a",
    projectId: "rec",
    kind: "part" as const,
    name: "Shockcord (200 ft)",
    partNumber: null,
    manufacturer: "Fruity Chutes",
    unitCostCents: 140,
    quantity: 200,
    shippingCents: 500,
    url: null,
  };
  it("keeps the line and its predicted cost as requested", () => {
    expect(snapshotOf(line, "LE4 Recovery", 0)).toMatchObject({ bomItemId: "a", projectName: "LE4 Recovery", predictedCents: 28500 });
  });
  it("flags a line whose cost moved after the request, or that was deleted", () => {
    const snap = snapshotOf(line, "LE4 Recovery", 0);
    expect(changedSinceRequested(snap, line)).toBe(false);
    expect(changedSinceRequested(snap, { ...line, quantity: 250 })).toBe(true);
    expect(changedSinceRequested(snap, null)).toBe(true);
  });
  it("totals the snapshots", () => {
    expect(requestTotal([{ predictedCents: 28500 }, { predictedCents: 1500 }])).toBe(30000);
  });
});

describe("partial approval", () => {
  it("approves every item when none are picked", () => {
    expect([...itemsToApprove(["a", "b", "c"])]).toEqual(["a", "b", "c"]);
  });
  it("approves only the picked items", () => {
    expect([...itemsToApprove(["a", "b", "c"], ["c", "a"])].sort()).toEqual(["a", "c"]);
  });
  it("refuses an empty pick (that is a rejection) and items from elsewhere", () => {
    expect(() => itemsToApprove(["a"], [])).toThrow(/at least one/);
    expect(() => itemsToApprove(["a"], ["z"])).toThrow(/isn't on this request/);
  });
  it("reads an item's outcome, older approvals counting every line", () => {
    expect(itemApproved("approved", false)).toBe(false);
    expect(itemApproved("approved", null)).toBe(true);
    expect(itemApproved("pending", null)).toBeNull();
    expect(itemApproved("rejected", null)).toBe(false);
  });
});
