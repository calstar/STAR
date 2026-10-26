import { describe, expect, it } from "vitest";

import { fieldsUsed, render } from "./merge";

describe("render", () => {
  it("fills fields and reports the ones it couldn't", () => {
    expect(render("Hi {{first_name}}, about {{org}}.", { first_name: "Cindy" })).toEqual({
      text: "Hi Cindy, about [org].",
      missing: ["org"],
    });
  });
  it("uses a fallback instead of reporting", () => {
    expect(render("Hi {{first_name|there}},", {})).toEqual({ text: "Hi there,", missing: [] });
  });
  it("switches renewal wording with sections", () => {
    const t = "Thank you for {{#renewal}}continuing to support{{/renewal}}{{^renewal}}considering{{/renewal}} STAR.";
    expect(render(t, { renewal: true }).text).toBe("Thank you for continuing to support STAR.");
    expect(render(t, { renewal: false }).text).toBe("Thank you for considering STAR.");
  });
  it("merges inside a section and drops a section on an empty field", () => {
    const t = "{{#ask}}We'd love {{ask}} for {{project|the team}}.{{/ask}}Done";
    expect(render(t, { ask: "2 GO 3S cameras" }).text).toBe("We'd love 2 GO 3S cameras for the team.Done");
    expect(render(t, { ask: "" }).text).toBe("Done");
  });
});

describe("fieldsUsed", () => {
  it("lists plain and section fields once", () => {
    expect(fieldsUsed("{{#renewal}}x{{/renewal}} {{org}} {{org|y}}")).toEqual(["renewal", "org"]);
  });
});
