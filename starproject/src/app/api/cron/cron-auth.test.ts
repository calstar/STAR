import { afterEach, describe, expect, it } from "vitest";

import { POST as deadlines } from "./deadlines/route";
import { POST as digest } from "./digest/route";
import { POST as emailBatch } from "./email-batch/route";

// The cron routes send email to the whole team, so they must fail closed: with
// no CRON_SECRET configured, or the wrong one sent, nothing runs. (They used to
// skip the check when the secret was unset, which left them open to any
// signed-in member and to every container on the compose network.)

const ROUTES = { deadlines, digest, emailBatch };
const saved = process.env.CRON_SECRET;

afterEach(() => {
  if (saved === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved;
});

const post = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/cron/x", { method: "POST", headers });

describe.each(Object.entries(ROUTES))("POST /api/cron/%s", (_name, handler) => {
  it("refuses when CRON_SECRET is unset, header or not", async () => {
    delete process.env.CRON_SECRET;
    expect((await handler(post())).status).toBe(401);
    expect((await handler(post({ "x-cron-secret": "" }))).status).toBe(401);
    expect((await handler(post({ "x-cron-secret": "anything" }))).status).toBe(401);
  });

  it("refuses a wrong or missing secret when one is configured", async () => {
    process.env.CRON_SECRET = "s3cret-s3cret-s3cret";
    expect((await handler(post())).status).toBe(401);
    expect((await handler(post({ "x-cron-secret": "nope" }))).status).toBe(401);
  });
});
