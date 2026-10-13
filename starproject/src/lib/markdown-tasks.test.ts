import { describe, expect, it } from "vitest";

import { toggleTaskAt } from "@/lib/markdown-tasks";

describe("toggleTaskAt", () => {
  const md = "Steps:\n\n- [ ] cut stock\n- [x] face it\n* [X] deburr\n1. [ ] inspect\n";
  const at = (s: string) => md.indexOf(s);

  it("checks an open item and unchecks a done one", () => {
    expect(toggleTaskAt(md, at("- [ ] cut"))).toBe(md.replace("- [ ] cut", "- [x] cut"));
    expect(toggleTaskAt(md, at("- [x] face"))).toBe(md.replace("- [x] face", "- [ ] face"));
    expect(toggleTaskAt(md, at("* [X] deburr"))).toBe(md.replace("* [X] deburr", "* [ ] deburr"));
  });

  it("handles ordered and indented items", () => {
    expect(toggleTaskAt(md, at("1. [ ]"))).toBe(md.replace("1. [ ] inspect", "1. [x] inspect"));
    const nested = "- [ ] parent\n  - [ ] child\n";
    expect(toggleTaskAt(nested, nested.indexOf("  - [ ] child"))).toBe(
      "- [ ] parent\n  - [x] child\n",
    );
  });

  it("only touches the item at the offset", () => {
    const out = toggleTaskAt(md, at("- [ ] cut"))!;
    expect(out.match(/\[x\]/g)).toHaveLength(2); // cut (new) + face (unchanged)
  });

  it("leaves text alone where there is no task box", () => {
    expect(toggleTaskAt(md, 0)).toBeNull();
    expect(toggleTaskAt("- plain item", 0)).toBeNull();
    expect(toggleTaskAt(md, -1)).toBeNull();
    expect(toggleTaskAt(md, md.length + 5)).toBeNull();
  });
});
