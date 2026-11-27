import type { ReimbursementStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { BULK_ACTIONS, bulkApplies, type BulkAction } from "@/lib/finance/bulk";
import { STATUS_LABEL, canTransition, type Actor } from "@/lib/finance/status";

const STATUSES = Object.keys(STATUS_LABEL) as ReimbursementStatus[];
const TARGET: Record<BulkAction, ReimbursementStatus> = {
  approve: "awaiting_send",
  send: "approved",
  retry: "approved",
  reject: "rejected",
  cancel: "cancelled",
};
// Send and Retry both put it in the queue; which one it is depends on where it starts.
const OWNS: Partial<Record<BulkAction, ReimbursementStatus>> = { send: "awaiting_send", retry: "failed" };
const expected = (a: BulkAction, s: ReimbursementStatus, actors: Actor[]) =>
  canTransition(s, TARGET[a], actors) && (OWNS[a] === undefined || OWNS[a] === s);
const PEOPLE = [
  { isAdmin: true, isPvp: false },
  { isAdmin: false, isPvp: true },
  { isAdmin: true, isPvp: true },
  { isAdmin: false, isPvp: false },
];
const actorsOf = (w: { isAdmin: boolean; isPvp: boolean }): Actor[] => [
  ...(w.isAdmin ? (["admin"] as const) : []),
  ...(w.isPvp ? (["pvp"] as const) : []),
];

describe("bulkApplies", () => {
  it("offers exactly the moves the status machine allows staff", () => {
    for (const a of BULK_ACTIONS)
      for (const s of STATUSES)
        for (const w of PEOPLE) expect(bulkApplies(a, s, w), `${a} ${s} ${JSON.stringify(w)}`).toBe(expected(a, s, actorsOf(w)));
  });

  it("keeps sending and retrying to PVPs", () => {
    expect(bulkApplies("send", "awaiting_send", { isAdmin: true, isPvp: false })).toBe(false);
    expect(bulkApplies("send", "awaiting_send", { isAdmin: false, isPvp: true })).toBe(true);
    expect(bulkApplies("retry", "failed", { isAdmin: true, isPvp: false })).toBe(false);
  });

  it("never offers anything once it is on CalLink", () => {
    for (const a of BULK_ACTIONS) expect(bulkApplies(a, "submitted", { isAdmin: true, isPvp: true })).toBe(false);
  });
});
