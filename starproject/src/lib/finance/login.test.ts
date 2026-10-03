import { describe, expect, it } from "vitest";

import { LOGIN_PICKUP_MS, LOGIN_RUN_MS, canRequestLogin, loginView } from "./login";

const t0 = new Date("2026-10-02T12:00:00Z");
const at = (ms: number) => t0.getTime() + ms;
const status = (loginState: string | null, updatedMs = 0, note: string | null = null) => ({
  loginState,
  loginRequestedAt: t0,
  loginUpdatedAt: new Date(at(updatedMs)),
  loginNote: note,
});

describe("loginView", () => {
  it("is idle when nobody has asked", () => {
    expect(loginView(null, at(0))).toEqual({ kind: "idle" });
    expect(loginView(status(null), at(0))).toEqual({ kind: "idle" });
  });

  it("waits for pickup, then gives up so no push arrives late", () => {
    expect(loginView(status("requested"), at(LOGIN_PICKUP_MS - 1)).kind).toBe("busy");
    expect(loginView(status("requested"), at(LOGIN_PICKUP_MS))).toMatchObject({ kind: "done", ok: false });
  });

  it("says to approve the push while Duo waits", () => {
    expect(loginView(status("waiting_duo", 10_000), at(20_000))).toMatchObject({ kind: "busy", text: expect.stringMatching(/approve/) });
  });

  it("stops showing busy when the worker goes quiet", () => {
    expect(loginView(status("waiting_duo", 0), at(LOGIN_RUN_MS))).toMatchObject({ kind: "done", ok: false });
  });

  it("reports the outcome", () => {
    expect(loginView(status("ok", 5000), at(6000))).toMatchObject({ kind: "done", ok: true });
    expect(loginView(status("failed", 5000, "Duo timed out"), at(6000))).toMatchObject({ ok: false, text: expect.stringMatching(/Duo timed out/) });
  });
});

describe("canRequestLogin", () => {
  it("refuses a second request while one is in flight", () => {
    expect(canRequestLogin(status("running", 0), at(1000))).toBe(false);
    expect(canRequestLogin(status("requested"), at(1000))).toBe(false);
  });
  it("allows one after the last finished or went stale", () => {
    expect(canRequestLogin(status("ok"), at(1000))).toBe(true);
    expect(canRequestLogin(status("requested"), at(LOGIN_PICKUP_MS))).toBe(true);
    expect(canRequestLogin(null, at(0))).toBe(true);
  });
});
