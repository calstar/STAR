import { describe, expect, it } from "vitest";

import { checkWorkerToken } from "@/lib/finance/worker-auth";

const SECRET = "x".repeat(40);

describe("checkWorkerToken", () => {
  it("lets the right token in", () => {
    expect(checkWorkerToken(`Bearer ${SECRET}`, SECRET)).toBe("ok");
  });

  it("keeps everything else out", () => {
    expect(checkWorkerToken(`Bearer ${SECRET}y`, SECRET)).toBe("unauthorized");
    expect(checkWorkerToken(SECRET, SECRET)).toBe("unauthorized");
    expect(checkWorkerToken(null, SECRET)).toBe("unauthorized");
    expect(checkWorkerToken("Bearer ", SECRET)).toBe("unauthorized");
  });

  it("fails closed when no usable secret is configured", () => {
    expect(checkWorkerToken("Bearer anything", undefined)).toBe("misconfigured");
    expect(checkWorkerToken("Bearer ", "")).toBe("misconfigured");
    expect(checkWorkerToken("Bearer short", "short")).toBe("misconfigured");
  });
});
