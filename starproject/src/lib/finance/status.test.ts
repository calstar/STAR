import { describe, expect, it } from "vitest";

import { canTransition, displayStatus, needsAdmin, needsPvp } from "@/lib/finance/status";

describe("canTransition", () => {
  it("lets only admins and PVPs approve or reject", () => {
    expect(canTransition("pending_approval", "awaiting_send", ["admin"])).toBe(true);
    expect(canTransition("pending_approval", "awaiting_send", ["pvp"])).toBe(true);
    expect(canTransition("pending_approval", "awaiting_send", ["owner"])).toBe(false);
    expect(canTransition("pending_approval", "rejected", ["owner"])).toBe(false);
  });

  it("lets an admin approve their own request", () => {
    expect(canTransition("pending_approval", "awaiting_send", ["admin", "owner"])).toBe(true);
  });

  it("never lets an approval reach the worker's queue on its own", () => {
    expect(canTransition("pending_approval", "approved", ["admin", "pvp", "owner"])).toBe(false);
  });

  it("lets only a PVP send to CalLink or retry a failed filing", () => {
    expect(canTransition("awaiting_send", "approved", ["pvp"])).toBe(true);
    expect(canTransition("awaiting_send", "approved", ["admin", "owner"])).toBe(false);
    expect(canTransition("failed", "approved", ["pvp"])).toBe(true);
    expect(canTransition("failed", "approved", ["admin"])).toBe(false);
  });

  it("lets the owner cancel only while it is pending", () => {
    expect(canTransition("pending_approval", "cancelled", ["owner"])).toBe(true);
    expect(canTransition("approved", "cancelled", ["owner"])).toBe(false);
    expect(canTransition("approved", "cancelled", ["admin"])).toBe(true);
  });

  it("never moves a filed request back", () => {
    for (const to of ["pending_approval", "approved", "cancelled", "failed"] as const) {
      expect(canTransition("submitted", to, ["admin", "owner", "worker"])).toBe(false);
    }
  });

  it("keeps filing to the worker", () => {
    expect(canTransition("approved", "submitting", ["admin"])).toBe(false);
    expect(canTransition("approved", "submitting", ["worker"])).toBe(true);
    expect(canTransition("submitting", "submitted", ["worker"])).toBe(true);
  });
});

describe("displayStatus", () => {
  const base = { callinkStatus: null, callinkDeletedOn: null, needsCheck: false };

  it("shows ours before filing and CalLink's after", () => {
    expect(displayStatus({ ...base, status: "pending_approval" }).label).toBe("Pending approval");
    expect(displayStatus({ ...base, status: "submitted", callinkStatus: "Unapproved" }).label).toBe(
      "Awaiting CalLink approval",
    );
    expect(displayStatus({ ...base, status: "submitted", callinkStatus: "Approved" }).tone).toBe("green");
  });

  it("puts needs-check and deletions ahead of everything", () => {
    expect(displayStatus({ ...base, status: "submitting", needsCheck: true }).key).toBe("needs_check");
    expect(
      displayStatus({ ...base, status: "submitted", callinkStatus: "Approved", callinkDeletedOn: "2026-01-01" }).label,
    ).toBe("Deleted on CalLink");
  });

  it("flags what an admin must act on", () => {
    expect(needsAdmin({ status: "pending_approval", needsCheck: false })).toBe(true);
    expect(needsAdmin({ status: "failed", needsCheck: false })).toBe(true);
    expect(needsAdmin({ status: "submitting", needsCheck: true })).toBe(true);
    expect(needsAdmin({ status: "submitted", needsCheck: false })).toBe(false);
    expect(needsAdmin({ status: "awaiting_send", needsCheck: false })).toBe(false);
  });

  it("flags what only a PVP can move on", () => {
    expect(needsPvp({ status: "awaiting_send" })).toBe(true);
    expect(needsPvp({ status: "failed" })).toBe(true);
    expect(needsPvp({ status: "pending_approval" })).toBe(false);
  });
});
