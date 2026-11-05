import { describe, expect, it } from "vitest";

import {
  UNTAGGED,
  isSummaryAccount,
  schoolYearLabel,
  schoolYearOf,
  spendStage,
  SCHOOL_MONTHS,
  spendingFor,
  yearsWithData,
  type SpendInput,
} from "@/lib/finance/ledger";
import { buildTree } from "@/lib/project-tree";

describe("schoolYearOf", () => {
  it("starts a year on July 1, Berkeley time", () => {
    expect(schoolYearOf("2026-10-08T12:00:00Z")).toBe(2026);
    expect(schoolYearOf("2027-03-01T12:00:00Z")).toBe(2026);
    expect(schoolYearOf("2027-07-01T12:00:00Z")).toBe(2027);
    // 11 pm on June 30 in Berkeley is already July 1 in UTC.
    expect(schoolYearOf("2027-07-01T06:00:00Z")).toBe(2026);
  });

  it("labels a year by both halves", () => {
    expect(schoolYearLabel(2026)).toBe("2026–27");
    expect(schoolYearLabel(2099)).toBe("2099–00");
  });
});

describe("spendStage", () => {
  const r = (status: SpendInput["status"], callinkStatus: string | null = null, deleted = false) =>
    spendStage({ status, callinkStatus, callinkDeletedOn: deleted ? new Date() : null });

  it("counts approved CalLink requests as paid", () => {
    expect(r("submitted", "Approved")).toBe("paid");
    expect(r("submitted", "Completed")).toBe("paid");
  });

  it("counts requests on their way as pending", () => {
    expect(r("pending_approval")).toBe("pending");
    expect(r("approved")).toBe("pending");
    expect(r("submitting")).toBe("pending");
    expect(r("submitted", "Unapproved")).toBe("pending");
  });

  it("leaves out money that will never go out", () => {
    expect(r("rejected")).toBeNull();
    expect(r("cancelled")).toBeNull();
    expect(r("failed")).toBeNull();
    expect(r("submitted", "Denied")).toBeNull();
    expect(r("submitted", "Canceled")).toBeNull();
    expect(r("submitted", "Approved", true)).toBeNull();
  });
});

describe("spendingFor", () => {
  const tree = buildTree([
    { id: "le4", name: "LE4", color: null, parentId: null, archived: false },
    { id: "eng", name: "Engine", color: null, parentId: "le4", archived: false },
    { id: "old", name: "LE3", color: null, parentId: null, archived: true },
  ]);
  const subteams = [
    { id: "prop", name: "Propulsion" },
    { id: "avi", name: "Avionics" },
  ];
  const row = (cents: number, extra: Partial<SpendInput> = {}): SpendInput => ({
    amountCents: cents,
    approvedAmountCents: null,
    status: "submitted",
    callinkStatus: "Approved",
    callinkDeletedOn: null,
    submittedOn: new Date("2026-10-01T12:00:00Z"),
    createdAt: new Date("2026-10-01T12:00:00Z"),
    projectId: null,
    subteamId: null,
    ...extra,
  });

  const rows = [
    row(10_000, { projectId: "eng", subteamId: "prop" }),
    row(5_000, { projectId: "le4", subteamId: "prop", approvedAmountCents: 4_000 }),
    row(2_500, { projectId: "old", subteamId: "avi", status: "pending_approval", callinkStatus: null, submittedOn: null }),
    row(700),
    row(99_999, { projectId: "eng", callinkStatus: "Denied" }),
    row(88_888, { projectId: "eng", submittedOn: new Date("2026-06-30T12:00:00Z") }),
  ];
  const s = spendingFor(2026, rows, subteams, tree);

  it("totals the year, paid and pending apart, at the approved amount", () => {
    expect(s.total).toEqual({ paidCents: 10_000 + 4_000 + 700, pendingCents: 2_500, count: 4 });
  });

  it("rolls subprojects into their parent and keeps archived projects", () => {
    expect(s.byProject.map((p) => [p.name, p.depth, p.bucket.paidCents + p.bucket.pendingCents])).toEqual([
      ["LE4", 0, 14_000],
      ["Engine", 1, 10_000],
      ["LE3", 0, 2_500],
      [UNTAGGED, 0, 700],
    ]);
  });

  it("sorts subteams by spend and puts untagged last", () => {
    expect(s.bySubteam.map((t) => [t.name, t.bucket.count])).toEqual([
      ["Propulsion", 2],
      ["Avionics", 1],
      [UNTAGGED, 1],
    ]);
  });

  it("books each month, July first, in Berkeley time", () => {
    const m = spendingFor(
      2026,
      [
        row(100, { submittedOn: new Date("2026-07-01T08:00:00Z") }), // 1 am Jul 1 in Berkeley
        row(200, { submittedOn: new Date("2027-01-01T07:00:00Z") }), // 11 pm Dec 31 in Berkeley
        row(300, { submittedOn: new Date("2027-06-30T12:00:00Z"), callinkStatus: "Unapproved" }),
      ],
      subteams,
      tree,
    ).byMonth;
    expect(m).toHaveLength(12);
    expect(m[0]).toEqual({ paidCents: 100, pendingCents: 0, count: 1 });
    expect(m[5]).toEqual({ paidCents: 200, pendingCents: 0, count: 1 });
    expect(m[11]).toEqual({ paidCents: 0, pendingCents: 300, count: 1 });
    expect(s.byMonth[3].paidCents + s.byMonth[3].pendingCents).toBe(s.total.paidCents + s.total.pendingCents);
  });

  it("orders every subteam and top-level project for colouring, spent on or not", () => {
    expect(s.subteamOrder).toEqual(["prop", "avi"]);
    expect(s.projectOrder).toEqual(["le4", "old"]);
  });

  it("treats a tag whose project or subteam is gone as untagged", () => {
    const g = spendingFor(2026, [row(100, { projectId: "nope", subteamId: "nope" })], subteams, tree);
    expect(g.byProject.map((p) => p.name)).toEqual([UNTAGGED]);
    expect(g.bySubteam.map((p) => p.name)).toEqual([UNTAGGED]);
  });
});

describe("SCHOOL_MONTHS", () => {
  it("starts in July", () => {
    expect(SCHOOL_MONTHS[0]).toBe("Jul");
    expect(SCHOOL_MONTHS[11]).toBe("Jun");
  });
});

describe("yearsWithData", () => {
  it("always offers this year, newest first", () => {
    expect(yearsWithData(new Date("2026-10-08T12:00:00Z"), ["2024-09-01T12:00:00Z"], [2027])).toEqual([2027, 2026, 2024]);
  });
});

describe("isSummaryAccount", () => {
  it("finds CalLink's SUMMARY account by name", () => {
    expect(isSummaryAccount("SUMMARY-203828-Space Technologies and Rocketry")).toBe(true);
    expect(isSummaryAccount("3-70-203828-00000-MISC-STAR")).toBe(false);
  });
});
