import { describe, expect, it } from "vitest";

import { MERGE_FIELDS, fieldsUsed, render } from "./merge";
import { STARTER_TEMPLATES } from "./starter-templates";

const known = new Set(MERGE_FIELDS.map((f) => f.name));

describe("starter templates", () => {
  it("only use merge fields the Compose page fills", () => {
    for (const t of STARTER_TEMPLATES) {
      for (const f of [...fieldsUsed(t.subject), ...fieldsUsed(t.body)]) expect(known.has(f), `${t.name}: ${f}`).toBe(true);
    }
  });
  it("render cleanly for a sponsor with nothing but an org name", () => {
    const vars = { org: "Boeing", season: "2026–27", sender_name: "Ada L.", sender_email: "ada@berkeley.edu", renewal: true };
    for (const t of STARTER_TEMPLATES) {
      const out = render(t.body, vars);
      expect(out.text, t.name).not.toMatch(/\{\{|\}\}/);
      expect(out.missing, t.name).toEqual([]);
    }
  });
});
