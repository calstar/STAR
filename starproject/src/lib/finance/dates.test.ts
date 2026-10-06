import { describe, expect, it } from "vitest";

import { formatDay, formatItemDate } from "@/lib/finance/dates";

describe("finance dates", () => {
  it("reads instants in Berkeley time", () => {
    // 03:00 UTC on Oct 2 is still Oct 1 in California.
    expect(formatDay("2026-10-02T03:00:00Z")).toBe("Oct 1, 2026");
  });

  it("keeps a receipt's calendar day whatever the timezone", () => {
    expect(formatItemDate("2026-10-01")).toBe("Oct 1, 2026");
    expect(formatItemDate("10/1/26")).toBe("10/1/26");
    expect(formatItemDate("")).toBe("—");
  });
});
